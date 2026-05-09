# Durable Cache Scheduler and Byte Cache Plan

## Goal

Move cache work from best-effort in-memory queues to a power-off robust cache
system that can be stopped, restarted, and resumed without losing intent.

The frontend should eventually hit the upstream provider only for:

- live search
- comments
- final reader page image bytes

Everything else should come from our backend cache:

- manga detail metadata
- chapter lists
- chapter image URL metadata
- thumbnails, covers, avatars, and other small image bytes

## Current Gap

The cache tables are durable, but cache work is not. `CacheService` owns four
in-memory queues: foreground, observed, background, and image backlog. On
restart, completed data survives, but unfinished intent does not. Some work is
recovered heuristically from existing rows, but the queue itself is not the
source of truth.

That is not enough for daily crawls, user-priority promotion, byte caching, or
power-off recovery.

## Ownership Model

- **Durable scheduler owns work order.** It stores jobs, dedupes by resource,
  promotes priority, leases active work, retries failures, and recovers stale
  leases after restart.
- **Data cache engine owns structured provider data.** It writes manga detail,
  chapter list, chapter image metadata, and search discovery cache state.
- **Byte cache engine owns local bytes.** It downloads small provider assets,
  writes files atomically, records byte status, and serves local files.
- **Provider runtime and BrowserSession own upstream protocol.** Signing,
  headers, pagination shape, and Comix-specific parsing stay behind provider
  boundaries.
- **Frontend owns intent and observation.** It reports user-visible evidence:
  foreground opens, search-observed stale manga, and image-store results. It
  does not choose page numbers, storage layout, retry policy, or queue order.

## Durable Scheduler Schema

Add `cache_jobs`:

```sql
CREATE TABLE cache_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  priority INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  run_after INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  lease_owner TEXT,
  lease_until INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(kind, resource_key)
);
```

Scheduler states:

- `queued`: ready when `run_after <= now`
- `running`: claimed by one worker until `lease_until`
- `retry`: failed but eligible later
- `failed`: retry budget exhausted

Completed jobs are deleted. The cache row is the durable result; the job row is
only durable intent.

Priority values:

- `1000`: foreground user action
- `500`: observed user-adjacent work, such as search discovering stale data
- `100`: daily crawl
- `10`: background completion/backfill

Scheduler API:

- `enqueueUnique(kind, resourceKey, priority, payload, options)`
- `prependBatchUnique(jobs)` for daily crawl refreshes
- `promote(kind, resourceKey, priority, payloadPatch)`
- `claimNext(workerId, leaseMs)`
- `complete(jobId)`
- `retry(jobId, error, runAfter)`
- `fail(jobId, error)`
- `counts()`

The scheduler is the only writer of job state. Cache engines execute claimed
jobs and report success or failure back to the scheduler.

## Data Cache Jobs

Initial job kinds:

- `crawl-search-newest:{yyyy-mm-dd}`: daily newest crawl checkpoint
- `cache-manga-detail:{mangaId}`
- `cache-chapters:{mangaId}`
- `reconcile-chapters:{mangaId}`
- `cache-chapter-page-map:{mangaId}:{chapterId}`

Foreground reads can promote matching queued jobs. They should not duplicate
work for the same resource.

If a lower-priority job is already running, it finishes its current atomic
request/write. Higher-priority work runs next. We do not interrupt an in-flight
signed request unless the owning request layer gains safe cancellation.

## Cache Layers

The durable queue should make the cache layers explicit. Lower layers must not
block higher layers unless a foreground user action promotes them.

1. **Search thumbnails.** Live search is the only source for thumbnail byte
   discovery. Search rows enqueue `cache-byte` jobs for their cover/thumbnail
   URLs. This is the highest background crawl layer because it makes lists
   visually complete.
2. **Manga details.** Detail metadata fills title metadata, tags,
   recommendations, descriptions, and related app data. It does not scan for
   more thumbnails; thumbnails come from search discovery only.
3. **Chapter lists.** Chapter-list metadata fills chapter IDs, chapter numbers,
   groups, and pagination.
4. **Chapter page maps.** `cache-chapter-page-map` fetches per-chapter page
   metadata and stores page image URLs plus possible store candidates for
   404/non-404 learning. It does not download reader image bytes. It should be
   cached eventually, but it is a later layer and should not be a giant
   speculative backlog ahead of search thumbnails, manga details, or chapter
   lists. Reader requests can promote a chapter page-map job to foreground.

## Daily Search Crawl

Once per day, enqueue a newest crawl job. It starts at newest page 1 and works
forward through search pages.

For each page:

1. Fetch live search through the same backend provider path used by frontend
   search.
2. Upsert the discovered manga card/search row into cache.
3. Enqueue thumbnail/cover byte jobs from the search row.
4. Enqueue or promote detail/chapter reconciliation jobs for each manga.
5. Store crawl checkpoint state in the job payload or `cache_meta`.

If yesterday's crawl is not finished when today's crawl starts, today's newest
pages are inserted at higher priority. Duplicate resources are promoted or
refreshed, not duplicated. Old unfinished work remains available after the new
newest frontier is handled.

Stop strategy can evolve, but the first version should support:

- stop at upstream last page
- stop at a conservative page cap
- stop after a long run of cache-fresh manga if that proves safe in logs

## Byte Cache Schema

Add `byte_cache`:

```sql
CREATE TABLE byte_cache (
  source_url TEXT PRIMARY KEY,
  local_key TEXT NOT NULL,
  content_type TEXT,
  bytes INTEGER,
  status TEXT NOT NULL,
  last_checked_at INTEGER,
  updated_at INTEGER NOT NULL,
  error TEXT
);
```

Byte files live under `${STATE_DIR}/bytes` unless overridden later. Writes use:

1. stream to temporary file
2. fsync where practical
3. atomic rename to final local key
4. update SQLite row after the file is durable

Status values:

- `queued`
- `ready`
- `failed`
- `gone`

## Byte Route

Add a backend byte route:

```http
GET /api/byte?url=<provider-url>
```

Behavior:

1. If `byte_cache.status = ready` and the file exists, serve the local file.
2. If missing, enqueue a foreground byte-cache job.
3. For early rollout, proxy-and-store on miss so the UI still has an image.
4. If proxy fails, record failure truthfully and return the real error.

This route replaces thumbnail use of `/api/image`. Reader page images stay on
the current image proxy/store-failover path because those are the large final
content bytes.

## Data and Byte Link

Raw provider payloads should stay raw. The cache database may remember provider
thumbnail URLs, but provider-shaped JSON should not be repeatedly mutated to
point to local files.

The app-facing normalized API layer can expose local byte routes for cover and
thumbnail fields. That gives the frontend stable URLs while preserving a clean
boundary between provider data and local byte policy.

If materialized local thumbnail URLs are needed later for speed, store them in
an app-owned side table or normalized cache field, not in raw provider JSON.

## Migration Order

1. Add `cache_jobs` and `byte_cache` tables. **Done.**
2. Add durable scheduler primitives and logs without changing active queue
   behavior. **Done.**
3. Convert existing `CacheService` enqueue/claim/done/fail logic to the durable
   scheduler. **Done.**
4. Derive cache status from durable jobs instead of in-memory arrays. **Done for
   `/api/cache/status`; remaining work is to simplify old recovery terminology.**
5. Add byte cache worker and `/api/byte`. **Done.**
6. Switch cover/thumbnail URLs to `/api/byte`. **Done for the frontend cover
   helper used by covers, avatars, comment images, favorites, search results,
   recommendations, and manga detail covers.**
7. Enqueue thumbnail byte jobs from search discovery only. **Done.**
8. Add daily crawl jobs and checkpoints. **Done for paginated newest crawl;
   remaining work is next-day frontier promotion if an old crawl is still
   unfinished.**
9. Add later-layer chapter page-map crawl policy after higher layers are
   drained. **Done for discovery. Chapter-list cache now enqueues background
   `cache-chapter-page-map` jobs for chapters missing page-map metadata.**

Each step should build/restart independently and keep logs strong enough to
prove whether the new owner is actually owning the behavior.

## Implementation Progress

- Added `BYTE_CACHE_DIR` config.
- Added `cache_jobs` and `byte_cache` SQLite schema.
- Added scheduler database primitives for unique enqueue, promotion, claiming,
  completion, retry, failure, and job counts.
- Added `DurableJobScheduler` as the policy wrapper over the SQLite job
  primitives.
- Verified that the managed service starts and the new table counts are visible
  through `/api/cache/status`.
- Converted `CacheService` enqueue, claim, completion, retry, and foreground
  promotion to the durable scheduler.
- Added startup recovery for jobs left `running` by a previous service process.
- Added `ByteCacheService` and `/api/byte`.
- Switched `coverProxyUrl` to use `/api/byte`; reader page images still use
  `/api/image`.
- Verified `/api/byte` against a real cached Comix thumbnail. First hit
  proxied and stored 42 KB locally; second hit served the local file without a
  new `miss-store` log.
- Added `cache-byte` durable worker support. Paginated search discovery
  enqueues thumbnail byte jobs; manga-detail cache no longer scans for
  thumbnails.
- Renamed the confusing `cache-chapter-images` job to
  `cache-chapter-page-map` in code and plan. This job owns URL/store-candidate
  metadata, not image byte downloads.
- Removed stale speculative `cache-chapter-images` queue rows from SQLite while
  preserving already cached chapter page-map rows.
- Added daily newest crawl pagination. Each crawled search page upserts manga
  card data, enqueues thumbnail byte jobs from the search row, enqueues lower
  layer manga detail/chapter-list jobs, and queues the next search page.
- Tightened daily crawl restart behavior. Startup now resumes an existing
  durable crawl frontier for the current date instead of blindly starting page
  1 again, and multiple frontiers collapse instead of multiplying on restart.
- Search thumbnail discovery is now only from live search rows. There are no
  thumbnail extraction passes from manga detail or chapter metadata.
- Chapter page-map discovery is now cache-engine owned. When a chapter list is
  cached or reconciled, the backend enqueues missing `cache-chapter-page-map`
  jobs itself; the frontend only promotes specific reader-needed page maps.
- Tightened log ownership after the durable crawl proved too noisy: search page
  crawl logs aggregate discovery, the scheduler logs foreground/promotions and
  non-bulk lifecycle events, and the byte cache worker logs batch summaries plus
  failures instead of one success line per thumbnail.

The active cache worker now uses `cache_jobs`. The next step is to make the
daily crawl boundary stronger: if an unfinished older crawl exists when a new
day starts, the new newest frontier should run ahead of stale lower-page work
without duplicating resources.

## Verification

Use managed service logs after each restart:

```bash
journalctl --user -u manga-reader.service --since '<build time>' --until now --no-pager
```

Expected proof points:

- startup logs show durable job counts
- queued jobs survive service restart
- stale `running` leases are reclaimed
- foreground opens promote matching jobs
- daily newest crawl dedupes instead of duplicating work
- byte-cache misses enqueue one job per source URL
- byte-cache ready files are served locally
- provider thumbnail calls disappear after byte cache warms
