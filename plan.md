# Lean Reader Image Candidate Rewrite

## Goal

Remove the storage-heavy generated image candidate cache and make reader image loading use direct store candidates generated on demand.

Generated candidate URLs are not durable cache data. They are a response-time projection from canonical page URL + known store hosts.

## Ownership

- `chapter_image_cache` owns canonical provider facts only:
  - canonical page URL
  - width/height
  - page order
- `storeHosts` owns the compact known-host list.
- `CacheService` owns read-time candidate expansion for chapter-image responses.
- `ReaderMemoryManager` owns direct candidate loading and per-page winner selection.
- `image_store_status` owns only real observations from attempted loads.
- `/api/image` owns nothing after this rewrite and should be removed.

## Implementation Steps

1. Extend `ChapterPage` to carry `candidates: string[]`.
2. Remove frontend reader proxying through `/api/image`; page URLs become direct candidate URLs.
3. Generate candidates server-side when returning cached chapter images:
   - canonical URL first can be included in the shuffled set, but order should be randomized for discovery.
   - every candidate preserves the canonical path and swaps only the store hostname.
4. Make `ReaderMemoryManager` try candidates in order until one image loads.
5. Log and report every attempted candidate:
   - canonical URL
   - attempted URL
   - candidate index/count
   - ok/failure
   - status/error if known
   - elapsed time
6. Persist only actual observations in `image_store_status`.
7. Stop writing `image_store_candidates` entirely.
8. Drop/purge existing `image_store_candidates` bloat from SQLite.
9. Remove `/api/image` route and `imageProxy` service from the app.
10. Keep cover/thumbnail byte cache routes untouched.
11. Rebuild/restart and verify:
    - background data cache remains disabled
    - `/api/image` is not referenced
    - `image_store_candidates` no longer exists or is empty
    - reader image attempts produce observation logs

## Non-goals

- Do not keep a compatibility migration path for old reader image proxy behavior.
- Do not rank stores yet. Randomized order plus logs will produce evidence for a later ranking policy.
- Do not touch cover/thumbnail byte cache ownership.
