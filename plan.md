# Cache Architecture Plan

## Goal

Move normal app reads away from ad-hoc live Comix requests and toward a backend-owned cache.
Comix remains an ingestion source. The frontend reads cached manga/chapter/image metadata and
reports image-store observations back to the backend.

## Ownership

- Backend owns SQLite, cache invalidation, priority, and store-health policy.
- Frontend owns only user intent and image outcome observations.
- BrowserSession owns Comix runtime access and signed/encrypted upstream calls.
- Frontend prewarm is obsolete. Cache reads and explicit refreshes are the only
  frontend-owned data requests; background ingestion belongs to the cache service.
- Image store failover/cache status is a cache concern, not a reader concern.

## Layers

1. Seed manga cache
   - On backend start, fetch newest 100 manga.
   - Store the raw manga result and each manga row in SQLite.
   - Enqueue those manga IDs for chapter-list caching.

2. Chapter-list cache
   - Worker consumes manga IDs and caches full chapter lists.
   - Frontend priority requests can interrupt the background queue.
   - For now, a frontend refresh request invalidates that manga's cached chapter list and refetches it.

3. Chapter image/store cache
   - After chapter lists are cached, enqueue chapter image discovery.
   - Cache chapterId -> complete image pages and candidate store URLs.
   - A chapter-image cache row is user-visible `ready` only when the backend
     has populated every target page from Comix's own chapter detail client:
     `source=site-client`, `targetCount > 0`, `pages.length === targetCount`,
     and every page has a concrete image URL.
   - Empty, encrypted, partial, or DOM-observed payloads are diagnostic/incomplete
     states. They must not be served to the reader as loaded chapter images.
   - Cache per-image/per-store observations: last check time, status code, ok/not-ok.
   - Frontend reports image outcomes; backend updates SQLite.
   - On 404, backend marks that store candidate stale/bad and can prioritize refresh.

## Implemented Checkpoint

- Backend `cache/` folder owns SQLite persistence and cache worker policy.
- SQLite stores:
  - `manga_cache`
  - `chapter_list_cache`
  - `chapter_image_cache`
  - `image_store_candidates`
  - `image_store_status`
- The cache worker has three lanes:
  - foreground jobs from explicit user/frontend intent
  - background manga/chapter-list jobs
  - image backlog jobs, drained only after foreground/background list work
- Startup fetches newest 100 manga, persists manga rows, and queues chapter-list caching.
- Startup also reconstructs image backlog from persisted chapter lists, so image discovery
  survives process death or power loss.
- Chapter image writes are atomic: the chapter image payload and generated store candidates
  are committed in one SQLite transaction.
- BrowserSession owns Comix runtime access. It uses the Comix site client when signed chapter
  list API payloads are encrypted, and it also uses the shipped site client for chapter image
  payloads because raw chapter detail responses can be encrypted as `{ "e": "..." }`.
- Chapter image cache readiness is a completeness contract, not an existence check. The backend
  only serves chapter images when the normalized payload has `source=site-client`, a positive
  `targetCount`, and exactly that many populated pages. The frontend refuses zero-page cache
  payloads so the reader cannot hydrate an empty chapter as successfully loaded.
- Store candidates are expanded from real discovered image URLs by replacing only the known
  `wowpic*.store` host while preserving the path.
- API endpoints exist for cache status, cached manga, cached chapter lists, cached chapter
  images, manga refresh, and frontend image-store observations.
- Manga detail has a manual refresh button above the chapter list.
- A hard `systemctl --user kill --signal=KILL manga-reader.service` followed by service start
  was tested on 2026-05-09. The service recovered from SQLite, skipped cached chapter lists,
  reconstructed image backlog, and continued image discovery.
- On 2026-05-09, a bad cache-only reader path was found where encrypted chapter-detail payloads
  were stored as `empty` and then served as hits with `pages=0`. The fix made cache readiness
  explicit and verified chapter `7ez2/8996924` as `source=site-client pages=15 targetCount=15
  status=ready`.

## Later

- Decide whether cache-only frontend mode should become production behavior or remain a test
  mode.
- Add better invalidation policy beyond manual refresh and image 404 reports.
- Consider persisting job lease/attempt metadata if concurrent workers are introduced. The
  current single-worker recovery model reconstructs remaining work from durable cache rows.
