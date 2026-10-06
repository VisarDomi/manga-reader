# Scythe: resuming chapter 562 did not append 563

October 6, 2026. Follow-up to `3dadfe4` (edge-cache bypass for chapter lists).

## Causes

1. **The bypass made the Scythe list depend on the slowest endpoint.** `?nocache=`
   misses Cloudflare and the WordPress page cache (`x-wp-spc-disk-cache: BYPASS`),
   so the origin renders the series page from scratch: 6.5 s earlier in the day,
   82–85 s in the evening; the feed and REST API also exceeded 40 s. Native
   requests time out after 20 s without data and are retried indefinitely, so the
   reader could stay on "Loading chapters..." forever. Resuming at 562's last page
   puts the reader exactly there. On the phone the cached series page took 72 ms
   while the bypass request had not finished after 2 minutes.
2. **The list was fetched once per reader document.** A reader left open on 562
   (suspended app, Back/Forward cache) kept the list from before 563 existed and
   never asked again. The app's chapter-list memo also handed readers that old list.
3. **Stuck states.** A failed list or newer chapter was never retried, and errors
   thrown inside the list/append handlers left "Loading chapters..." or "Loading
   newer chapter..." on screen with no error.

## Changes

- Scythe reads only Cloudflare-cached pages: the series page plus the first Latest
  Update page (purged on publish; 20 series covering about three weeks). Chapters
  of the series that Latest Update shows but the cached list lacks are added in
  front; a larger gap is filled through each chapter page's `prevUrl` (at most 10),
  otherwise the cached list is used unchanged. Measured: 1.0 s, two requests, 563
  present. Home pages 2+ are not used: their edge copies were 14–61 days old.
  Asura keeps its bypass; its API answers a cache miss in about 0.1 s.
- The reader re-fetches the list while the newest listed chapter is being read once
  it is five minutes old, and checks when the page becomes visible again. Failed
  lists and newer chapters are retried on a later settled position after 15 s.
  Inconsistent lists and mismatched chapters show the existing error texts.
- The app's chapter-list memo serves background preparation only; readers always
  ask the provider (sharing a pending request). A changed list moves that series'
  previous/current/next download window.
- Resume is instant for every provider: each fetched list is saved on the phone with
  the prepared chapters, and the reader continues from it before the provider answers
  (silently refreshing). Measured on October 6, live provider latency varies widely:
  Lua lists took 8–25 s once and 0.1–0.3 s later; uncached Scythe series and chapter
  pages took 7–18 s and returned 502; Asura, QiScans, EzScans and Yaksha answered in
  0.05–1.1 s with lists consistent with their Home rows.

## Lua

Lua's API caches responses by exact URL and is slow on a miss: an uncached catalog of
1000 series took 5.1 s (100 series 0.3 s), an uncached chapter-list page 3.5–12.6 s.
The app's own URLs were rarely cached, so the first Home of a session waited about 5 s
and chapter lists 8–25 s (sequential pages). Now Home shows the newest 100 series
first (0.26 s measured) and completes from one full response (all 649 series; offset
pages were not used because rows sharing a sort key repeated and went missing).
Chapter lists use the website's own URL (`perPage=30&query=`), often warmed by its
readers, with the pages requested together. Lists stay slow when cold, so Home rows
also extend kept lists (see `apps/ios/DEVELOPMENT.md`).

Tests: `tests/unit/reader.test.ts` (stale list, visibility, retries, stuck states),
`tests/unit/scythe-chapter-list.test.ts`, `tests/unit/ios-chapter-list.test.ts`,
`tests/unit/ios-downloads.test.ts`, `tests/unit/chapter-list.test.ts`.
