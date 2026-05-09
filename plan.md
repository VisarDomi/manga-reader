# Cache Architecture Plan

## Goal

Move normal app reads away from ad-hoc live Comix requests and toward a backend-owned cache.
Comix remains an ingestion source. The frontend reads cached manga/chapter/image metadata and
reports image-store observations back to the backend.

## Ownership

- Backend owns SQLite, cache invalidation, priority, and store-health policy.
- Frontend owns only user intent and image outcome observations.
- BrowserSession owns Comix runtime access and signed/encrypted upstream calls.
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
   - Cache chapterId -> image pages and candidate store URLs.
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
  list API payloads are encrypted, and it can fall back to DOM-extracted chapter image URLs
  when the signed chapter detail API returns no pages.
- Store candidates are expanded from real discovered image URLs by replacing only the known
  `wowpic*.store` host while preserving the path.
- API endpoints exist for cache status, cached manga, cached chapter lists, cached chapter
  images, manga refresh, and frontend image-store observations.
- Manga detail has a manual refresh button above the chapter list.
- A hard `systemctl --user kill --signal=KILL manga-reader.service` followed by service start
  was tested on 2026-05-09. The service recovered from SQLite, skipped cached chapter lists,
  reconstructed image backlog, and continued image discovery.

## Later

- Serve search/manga/chapter data from cache routes by default.
- Add frontend requests that prioritize nearby manga/chapter/image cache jobs during scroll.
- Add better invalidation policy beyond manual refresh and image 404 reports.
- Consider persisting job lease/attempt metadata if concurrent workers are introduced. The
  current single-worker recovery model reconstructs remaining work from durable cache rows.
