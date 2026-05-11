# Data Cache Storage Report

Generated: 2026-05-11 12:35 CEST.

## Immediate Stop

Background data caching was stopped after the projected storage cost became unacceptable.

- Service was stopped immediately at `2026-05-11 12:24:02`.
- The app was restarted at `2026-05-11 12:26:15`.
- `DATA_CACHE_BACKGROUND_ENABLED = false` now prevents startup daily crawl and old background queue drain.
- Foreground cache requests can still run, so opening/requesting a manga can fill missing cache on demand.
- Post-restart logs showed `background-data-cache disabled; foreground requests only`.
- Post-restart logs showed `job_done_after_restart 0`, so bulk data caching was no longer running.

## Current Cache Size

SQLite file:

- `page_size`: 4096
- `page_count`: 2,301,985
- `freelist_count`: 0
- Approx DB size: 9.43 GB decimal, 8.78 GiB

Byte/cover cache directory:

- Approx bytes on disk: 8.31 GB decimal, 7.74 GiB
- Byte cache jobs left: 0
- Covers ready: 88,687 card and 88,687 detail

## Current Data Progress

Current rows:

- `manga_cache`: 88,889
- `chapter_list_cache`: 17,772
- `chapter_image_cache`: 16,927
- `image_store_candidates`: 23,602,425
- `image_store_status`: 0

Current queued/retry work:

- `cache-chapter-page-map`: 831,553 queued, 51 retry
- `cache-chapters`: 78,093 queued, 9,439 retry
- `cache-manga-detail`: 78,273 queued, 9,291 retry

Recent throughput before stop:

- 653 jobs from 12:10:32 to 12:22:37.
- Average: about 0.90 jobs/sec, 3,240 jobs/hour, 77,800 jobs/day.

If the previous expansion model continued:

- Existing queued/retry work: about 1.01M jobs.
- Remaining chapter lists would likely create about 3.40M more page-map jobs.
- Effective remaining work: about 4.40M jobs.
- ETA at the recent average: about 56.6 days, about 8.1 weeks.

## Why The DB Blew Up

The large table is not manga detail text, chapter list JSON, or chapter image JSON.

`dbstat` by table/index:

- `image_store_candidates`: 3.96 GB
- `sqlite_autoindex_image_store_candidates_1`: 3.97 GB
- `cache_jobs`: 0.32 GB
- `manga_cache`: 0.28 GB
- `chapter_list_cache`: 0.25 GB
- `cache_meta`: 0.17 GB
- `chapter_image_cache`: 0.11 GB

So roughly 7.93 GB of the 9.43 GB DB is `image_store_candidates` plus its primary-key index.

The candidate table shape is:

- `image_url TEXT`
- `store_url TEXT`
- timestamps/status columns
- primary key on `(image_url, store_url)`

For every discovered image URL, the current code generates candidates for every known store host:

- Current store host count: 25
- Distinct image URLs cached so far: 944,097
- Candidate rows: 23,602,425
- Candidate rows per image: exactly 25 in sampled groups
- Average `image_url`: 67.5 bytes
- Average `store_url`: 67.5 bytes

This means each image page stores the same path 25 times as full text URLs, then SQLite stores an equally large unique index over those full text URLs. That is the storage explosion.

## What Is Actually Small

Payload sizes:

- `chapter_image_cache` JSON total: about 0.10 GB for 16,927 chapter page maps
- Average `chapter_image_cache.data_json`: about 5.9 KB
- Average page count per cached chapter page map: 55.78
- Max page count seen: 519
- `chapter_list_cache` JSON total: about 0.24 GB for 17,772 manga
- Average `chapter_list_cache.data_json`: about 13.5 KB
- `manga_cache` JSON total: about 0.20 GB for 88,889 manga
- Average `manga_cache.data_json`: about 2.3 KB
- `cache_jobs` average payload: about 182 bytes

If we stopped storing pre-generated store candidates, projected full data cache becomes much closer to the target:

- Chapter page-map JSON projection: roughly 25 GB at current average.
- Chapter-list JSON projection: roughly 1.2 GB if all 88,889 manga get lists at current average.
- Manga-detail JSON is already mostly present and about 0.2 GB.
- Remaining queue and metadata overhead would still need cleanup, but the architecture could plausibly land near tens of GB instead of terabytes.

## Root Cause

The current cache conflates two different things:

1. Chapter image metadata: the canonical page URLs and dimensions returned by the provider/runtime.
2. Store-host candidate expansion: generated alternatives derived from the known host list.

The second one is not source data. It is a deterministic projection from:

- canonical image URL
- known store host list

Persisting every generated candidate as a full row makes the DB scale as:

`images * store_hosts * full_url_text * index_over_full_url_text`

That is why the data cache projects into terabytes.

## Better Direction

The owner of stored data should be the canonical chapter page map, not the generated store candidate list.

Recommended replacement:

- Store only canonical page URLs and dimensions in `chapter_image_cache`.
- Keep store hosts in the existing compact `store-hosts.json` or a small normalized table.
- Generate candidate URLs lazily at read time from canonical URL + store hosts.
- Persist only observations, not every possible candidate:
  - image canonical key
  - host id / hostname
  - last status
  - last ok
  - last checked
- If no observation exists, frontend/backend can still try generated candidates in deterministic order.

That changes storage from:

`images * 25 full URL rows`

to:

`images * 1 canonical URL + only observed host outcomes`

## Open Design Choice

After candidate-table removal, full eager page-map caching may be feasible around the 20-30 GB range, based on current averages.

The decision is then between:

1. Full data cache, but canonical-only.
   - First reader open is warm for all crawled manga.
   - Storage is likely tens of GB, not terabytes.
   - Still takes weeks unless concurrency/throughput improves.

2. On-demand page-map cache.
   - Storage remains bounded by what is actually read.
   - First reader open for uncached chapters is cold.
   - Safer until we prove full crawl economics.

3. Intelligent prewarm.
   - Cache manga/details/chapter lists broadly.
   - Cache page maps only for likely chapters:
     - latest chapter from search result
     - next unread chapter from favorites/progress
     - nearby chapters when a manga is opened
     - foreground reader requests
   - This likely gives the best user-visible speed per GB.

The immediate next investigation should quantify the canonical-only storage projection more precisely after deleting or ignoring `image_store_candidates`.

## Current Image Store Runtime Behavior

The current reader/frontend does not receive 25 store URLs.

Current path:

- `/api/cache/manga/:mangaId/chapters/:chapterId/images` returns provider chapter page data.
- The Comix provider parser returns one canonical `url` per page.
- The frontend wraps each page URL as `/api/image?url=<canonical>&referer=<chapter>`.
- `ReaderMemoryManager` fetches that proxied URL as a blob and assigns the blob URL to the image element.
- Backend `imageProxy` tries the canonical URL first.
- Backend failover only happens if canonical fetch fails with an allowed failover class.

Current failover behavior:

- 5xx, Cloudflare, timeout, and transport failures allow failover.
- 4xx does not currently allow failover.
- This is too conservative for the store-host problem because 404 is the normal signal that a generated/host-specific image path does not exist.

Observed evidence:

- Recent logs contained no `imageProxy failover hit` or `imageProxy failover miss`.
- Recent logs contained no `image-store-observed`.
- `image_store_status` has 0 rows.
- So we currently have no measured dependency ranking for the 25 stores.

Current candidate order:

- Canonical/original URL is tried first.
- Alternate hosts come from `listStoreHosts().sort()`, so order is stable alphabetical order.
- The default host set is 5 prefixes x 5 shards, currently 25 hosts.

## Preferred Next Architecture

The better behavior is not a minimal-preservation backend-proxy-only change. The better behavior is to make the data cache lean and move generated URL expansion to the server/provider response boundary.

Ownership:

- Cache owns durable source facts:
  - canonical page URL
  - page width/height
  - chapter/page order
  - known store host list
  - observed store outcomes, only after a real attempt
- Server/provider owns derived read-time projections:
  - generate the 25 candidate URLs from canonical URL + store hosts
  - randomize or rotate order so we can discover store quality instead of always biasing alphabetical order
  - include candidate URLs in the chapter image response
- Frontend owns runtime image selection:
  - try candidates without another round trip to ask the server for the next URL
  - report each success/failure back to the backend
  - keep scrolling/rendering independent of store-host retries
- Backend owns observation storage:
  - persist only actual outcomes, not all possible generated candidates
  - store canonical image key + host + status + ok + checked time

The initial implementation should randomize candidate order rather than overfit a ranking before we have evidence. After a day of logs, we can rank hosts by success rate, latency, manga/path pattern, or recent failure windows.

This preserves the important data-cache rule:

Generated candidate URLs are a response-time view, not cache rows.

## Implemented Rewrite Snapshot

Implemented on 2026-05-11 after the storage investigation.

What changed:

- `image_store_candidates` is no longer created or written.
- Existing `image_store_candidates` was dropped.
- SQLite was vacuumed after dropping it.
- DB size dropped from about 9.43 GB to about 1.43 GB.
- Freelist is back to 0 after vacuum.
- `/api/image` reader proxy route and `imageProxy` service were removed.
- Reader chapter image responses now include `candidates` generated at response time.
- Candidate URLs are direct store URLs, not proxy URLs.
- Candidate order is randomized for discovery.
- Reader image loading tries candidates in order until one succeeds.
- Frontend reports each attempted candidate to `/api/cache/image-store`.
- Backend persists only actual attempted outcomes in `image_store_status`.
- Cover/thumbnail byte cache routes are unchanged and still use `/api/cache/manga/:mangaId/cover/:variant`.

Verification:

- Sample cached chapter image response returned one canonical `url` and 25 direct `candidates`.
- Sample candidate did not include `/api/image`.
- Background data cache remains disabled with log: `background-data-cache disabled; foreground requests only`.
- Source search found no remaining `/api/image`, `imageProxyUrl`, `imageProxy`, or live `image_store_candidates` usage except the defensive `DROP TABLE IF EXISTS image_store_candidates` migration.

Current DB live table sizes after vacuum:

- Total DB: about 1.43 GB.
- `cache_jobs`: about 313 MB.
- `manga_cache`: about 263 MB.
- `chapter_list_cache`: about 251 MB.
- `cache_meta`: about 171 MB.
- `chapter_image_cache`: about 115 MB.

Next evidence to gather:

- Reader image candidate success/failure logs from iOS Safari.
- `image_store_status` rows after real reading.
- Whether direct store fetching has any iOS-specific CORS or network behavior difference.
- Host success rate and latency distribution after enough attempts.
