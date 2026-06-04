# Goal: Cache-First Provider Ownership

Active handoff. Read this after `decisions.md`.

## Product Rule

The app should serve from cache first. Foreground UI should show cached data
immediately when it exists, then ask the backend to refresh stale/missing data
asynchronously and swap in new data when the cache owner finishes.

This applies to:

- search results and favorite cards
- manga detail metadata, chapter lists, recommendations, and comments
- search/favorites/recommendation thumbnails
- manga-detail covers
- reader image metadata and direct/scrambled render candidates

## Current Issues To Investigate/Fix

1. Search thumbnails are missing on page 2+.
   - Suspected ownership leak: search appends provider results, but thumbnail
     byte/cache ownership may only be warming page 1 or may not rewrite later
     cards to local cover routes.
   - Fix must keep cards provider-neutral: frontend consumes normalized card
     data and local cache routes; provider/cache owns upstream thumbnail URLs.

2. Recommendations may have the same thumbnail ownership leak.
   - Check both manga-detail recommendations and reader-tail recommendations.
   - They use `MangaList`/`MangaCoverCard`, so the correct fix should probably
     be in card normalization or card snapshot ownership, not per-view patches.

3. Thumbnails/covers should be cache-owned.
   - On cache hit: serve local bytes immediately.
   - On cache miss: return a stable local image route, queue/promote byte work,
     and let the image route fetch/store/serve. The frontend should not need to
     know whether the bytes were already local or fetched on demand.

4. Cache miss behavior should not block the visible UI.
   - Cached stale data should be rendered first.
   - Refresh/update work should be explicit background/observed/interactive
     cache work, with the UI showing update state only where useful.

## Evidence So Far

- Logs after the 2026-06-04 13:50 restart show Comix provider runtime and cache
  running while Mangadotnet is disabled.
- Logs around 17:28 show many observed `cache-chapters` and
  `cache-manga-detail` jobs from search-result reconciliation. Detail jobs queue
  `cover:*:detail` byte cache work, but thumbnail/card behavior still needs
  tracing.
- Provider runtime enablement is now backend-owned. Disabled providers should
  not run browser/cache/byte-cache work.

## Implementation Rules

- Do not hardcode provider-specific thumbnail behavior in views.
- Keep one owner for each resource:
  - provider parses upstream shape
  - cache owns durable data and local image routes
  - byte cache owns image bytes
  - frontend renders normalized URLs and reports observations
- Prefer fixing `MangaCoverCard`/card normalization/card snapshot paths over
  patching search, manga-detail, and reader recommendations separately.
