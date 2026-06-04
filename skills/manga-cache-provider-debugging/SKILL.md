---
name: manga-cache-provider-debugging
description: Investigate manga-reader cache, provider, foreground priority, Comix/Mangadot, thumbnail/cover, chapter-list, chapter-image metadata, store selection, decoder, or warm/cold path issues.
---

# Manga Cache And Provider Debugging

Use this skill when cached data is slow, stale, missing, provider-specific,
warming forever, or when foreground requests lose to background work.

## Ownership Model

- Frontend reports evidence and priority; it does not repair provider data.
- Backend cache owns reconciliation, queueing, stale/fresh policy, and provider
  calls.
- Provider owns URL shape, parsing, runtime quirks, comments identifiers,
  chapter metadata, image-store candidate generation, and descrambling rules.
- Byte/cover/thumbnail cache owns downloaded local bytes.
- Reader owns the warm set for what can become visible.

## Expected App Behavior

- Serve cached data immediately when available.
- If stale or missing, enqueue/update in the backend asynchronously.
- Foreground/interactive user requests promote matching queued work.
- Visible reader images use critical/best-store ordering; offscreen warm work
  can use normal explore policy.
- Search can provide stale-cache evidence; favorites rely on background daily
  refresh unless the user opens a manga.

## Evidence Commands

```bash
journalctl --user -u manga-reader.service --since 'YYYY-MM-DD HH:MM:SS' --until now --no-pager
rg -n "cache|provider|foreground|background|priority|warm|stale|reconcile|byteCache|decoder|store-ranking|BrowserSession" packages
```

Find the actual cache DB path from code:

```bash
rg -n "STATE_DIR|CACHE_DB_PATH|cache-.*\\.sqlite|cache\\.sqlite|dbPath" packages/server/src
```

Current default DB paths are provider-specific under `STATE_DIR`:

```bash
ls -lh /home/visar/.local/state/manga-reader/cache*.sqlite

sqlite3 /home/visar/.local/state/manga-reader/cache.sqlite \
  "select kind,status,priority,count(*) from cache_jobs group by kind,status,priority order by kind,status,priority;"

sqlite3 /home/visar/.local/state/manga-reader/cache-mangadotnet.sqlite \
  "select kind,status,priority,count(*) from cache_jobs group by kind,status,priority order by kind,status,priority;"
```

If the state path differs, ask SQLite through code/config rather than guessing.

List provider-specific cache tables before writing queries against a possibly
drifted schema:

```bash
sqlite3 /home/visar/.local/state/manga-reader/cache.sqlite ".tables"
sqlite3 /home/visar/.local/state/manga-reader/cache-mangadotnet.sqlite ".schema cache_jobs"
```

Check cache table sizes and likely bloat:

```bash
sqlite3 /home/visar/.local/state/manga-reader/cache.sqlite \
  "select 'manga_cache', count(*) from manga_cache union all
   select 'chapter_list_cache', count(*) from chapter_list_cache union all
   select 'chapter_image_cache', count(*) from chapter_image_cache union all
   select 'manga_cover_cache', count(*) from manga_cover_cache union all
   select 'byte_cache', count(*) from byte_cache union all
   select 'cache_jobs', count(*) from cache_jobs;"

du -h /home/visar/.local/state/manga-reader/cache*.sqlite
```

Inspect one manga's foreground queue ownership:

```bash
MANGA_ID='<id>'
sqlite3 /home/visar/.local/state/manga-reader/cache.sqlite \
  "select id,kind,status,priority,resource_key,json_extract(payload_json,'$.reason') as reason,attempts,last_error
   from cache_jobs where resource_key like '%'"$MANGA_ID"'%' order by priority desc, updated_at desc limit 30;"
```

Check provider/cache logs for one manga:

```bash
journalctl --user -u manga-reader.service --since 'YYYY-MM-DD HH:MM:SS' --until now --no-pager \
  | rg "manga=<id>|mangaId=<id>|<id>|cache|foreground|warming|ready|provider|decoder"
```

Check whether background work is competing with foreground requests:

```bash
journalctl --user -u manga-reader.service --since 'YYYY-MM-DD HH:MM:SS' --until now --no-pager \
  | rg "foreground|background|observed-job|cache-job|promote|priority|ready|warming|timeout|provider-error"
```

## SQLite Cookbook

Use SQL to answer ownership questions directly. Prefer read-only SELECTs unless
the user explicitly asks for repair.

Set the DB once per shell:

```bash
DB=/home/visar/.local/state/manga-reader/cache.sqlite
MDB=/home/visar/.local/state/manga-reader/cache-mangadotnet.sqlite
```

Show schema and indexes before writing clever queries:

```bash
sqlite3 "$DB" ".tables"
sqlite3 "$DB" ".schema cache_jobs"
sqlite3 "$DB" ".indexes cache_jobs"
```

Queue health by kind/status/priority:

```bash
sqlite3 "$DB" "
select kind, status, priority, count(*) as n,
       min(datetime(created_at/1000,'unixepoch','localtime')) as oldest,
       max(datetime(updated_at/1000,'unixepoch','localtime')) as newest
from cache_jobs
group by kind, status, priority
order by kind, status, priority desc;"
```

Runnable work that should be claimed next:

```bash
sqlite3 "$DB" "
select id, kind, status, priority, json_extract(payload_json,'$.reason') as reason, attempts, max_attempts,
       datetime(run_after/1000,'unixepoch','localtime') as run_after,
       resource_key,
       substr(last_error,1,160) as err
from cache_jobs
where status in ('queued','retry') and run_after <= strftime('%s','now') * 1000
order by priority desc, run_after asc, created_at asc
limit 30;"
```

Stuck leased/running jobs:

```bash
sqlite3 "$DB" "
select id, kind, status, priority, attempts,
       datetime(lease_until/1000,'unixepoch','localtime') as lease_until,
       datetime(updated_at/1000,'unixepoch','localtime') as updated,
       resource_key,
       substr(last_error,1,180) as err
from cache_jobs
where status in ('running','leased') or (lease_until is not null and lease_until < strftime('%s','now') * 1000)
order by updated_at asc
limit 40;"
```

Failure clusters:

```bash
sqlite3 "$DB" "
select kind, attempts, max_attempts, count(*) as n,
       substr(last_error,1,120) as err
from cache_jobs
where status in ('failed','queued') and coalesce(last_error,'') <> ''
group by kind, attempts, max_attempts, err
order by n desc
limit 30;"
```

Find cache readiness for one manga/chapter:

```bash
MANGA_ID='<manga-id>'
CHAPTER_ID='<chapter-id>'
sqlite3 "$DB" "
select 'manga' as table_name, manga_id, datetime(updated_at/1000,'unixepoch','localtime') as updated_at
from manga_cache where manga_id='$MANGA_ID'
union all
select 'chapter_list', manga_id, datetime(updated_at/1000,'unixepoch','localtime')
from chapter_list_cache where manga_id='$MANGA_ID';"

sqlite3 "$DB" "
select manga_id, chapter_id, status,
       datetime(updated_at/1000,'unixepoch','localtime') as updated_at,
       length(data_json) as json_bytes
from chapter_image_cache
where manga_id='$MANGA_ID' and chapter_id='$CHAPTER_ID';"
```

Estimate cache size and bloat:

```bash
du -h "$DB" "$MDB"
sqlite3 "$DB" "
select name, sum(pgsize) as bytes
from dbstat
group by name
order by bytes desc
limit 20;"
```

Check image-store winner data, including slow/error stores:

```bash
sqlite3 "$DB" "
select host, status, count(*) as n,
       round(avg(total_ms),1) as avg_ms,
       max(total_ms) as max_ms
from image_store_observations
group by host, status
order by status, n desc
limit 40;"
```

Get tail latency per store for policy tuning:

```bash
sqlite3 "$DB" "
with ranked as (
  select host, total_ms,
         row_number() over (partition by host order by total_ms) as rn,
         count(*) over (partition by host) as n
  from image_store_observations
  where ok = 1
)
select host, n,
       min(case when rn >= cast(n * 0.90 + 0.999 as int) then total_ms end) as p90ish,
       min(case when rn >= cast(n * 0.95 + 0.999 as int) then total_ms end) as p95ish,
       min(case when rn >= cast(n * 0.98 + 0.999 as int) then total_ms end) as p98ish,
       max(total_ms) as max_ok
from ranked
group by host, n
order by p95ish asc
limit 20;"
```

Compare providers without guessing:

```bash
for db in "$DB" "$MDB"; do
  echo "--- $db"
  sqlite3 "$db" "
  select 'manga_cache', count(*) from manga_cache union all
  select 'chapter_list_cache', count(*) from chapter_list_cache union all
  select 'chapter_image_cache', count(*) from chapter_image_cache union all
  select 'cache_jobs', count(*) from cache_jobs union all
  select 'byte_cache', count(*) from byte_cache union all
  select 'manga_cover_cache', count(*) from manga_cover_cache;"
done
```

If a query fails, inspect `.schema` and update the skill; do not silently assume
the old schema still exists.

## Questions Logs Must Answer

For a slow manga open:

1. Did the frontend request cached detail/chapter list first?
2. Was there a cache hit, warming response, stale response, or miss?
3. Did backend promote foreground work or leave it behind background work?
4. Was the delay provider runtime, SQL, browser session, decoder, image-store
   selection, or frontend commit/render?
5. Did the UI render stale cache while refresh continued, or did it block?

For a reader image delay:

1. Was chapter image metadata cached?
2. Were store candidates generated on the fly or read from cache?
3. Was the visible image marked critical?
4. Did store selection choose a current winner or exploration candidate?
5. If scrambled, did decoder warm and decode on the correct chapter context?

## Good Patterns From History

- Replace live ad-hoc fetches with cache-backed provider-owned endpoints.
- Durable jobs live in SQLite and recover after power loss.
- Job queues are resource-key scoped; foreground checks must not scan huge
  global tables.
- Daily crawl runs at local `04:45`; foreground work still wins.
- Cache invalidation should replace rows atomically; do not delete usable stale
  rows before replacement unless the row is structurally invalid.
- Chapter-image metadata jobs are not image-byte downloads; name them clearly.
- If generated data explodes database size, cache only true provider facts and
  generate candidates on demand.

## Rejected Patterns

- Frontend waiting on cache miss before showing stale cached rows.
- Generic proxy routes for provider-specific live calls.
- Depending on minified upstream export names.
- Hardcoded store winners or warm counts.
- Background speculative jobs competing with visible/foreground work.
- Swallowing provider/cache errors without logs.

## Verification

After a cache/provider fix:

```bash
npm run build
npm run restart
curl -sk https://localhost:11555/api/health
journalctl --user -u manga-reader.service --since 'YYYY-MM-DD HH:MM:SS' --until now --no-pager
```

Then test both:

- cold-ish first open of a manga/chapter, to verify promotion and warming;
- second open of same item, to verify cache hit is fast.
