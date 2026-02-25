# TODO

## Pending

## In Progress

## Done
31. ~~**Strip diagnostic logging**~~ — removed DEBUG flag, log helper, debugDump, diag, _snap, all [COMIX:*] log calls. Operational console.error/warn in catch blocks stays.
23. ~~**Debug load-more stops + manga details unclickable after heavy scrolling**~~ — root cause found (iOS WebKit IO zombie) and fixed via generation counter + health check; diagnostic logging served its purpose and removed
30. ~~**Fix sentinel IO breaks after CSS visibility changes on iOS WebKit**~~ — generation counter forces IO recreation on view return, health check catches missed intersections
29. ~~**Loading watchdog + scroll container recovery**~~ — 15s timeout on isLoading, force re-layout on iOS scroll containers to recover touch handling
28. ~~**Show tags in manga details**~~ — Tags from `term_ids` displayed as chips in manga detail header
27. ~~**Move global styles.css into Svelte component `<style>` blocks**~~ — Scoped CSS per component, styles.css retains only global resets + `.empty` utility
26. ~~**Manga card chapter display redesign**~~ — Resume + latest inline with `/` divider, green pill when they differ, removed old badge
25. ~~**Favorites feature**~~ — heart button in manga details, Favs toggle in search bar, backend JSON file storage, optimistic updates
24. ~~**Fix reader only buffering one next chapter**~~ — one-shot IO recheck after each load; 500% rootMargin is the sole limit
22. ~~**3s debounce on filter changes**~~ — debouncedOnChange in FilterState, prevents search spam when toggling multiple chips
21. ~~**Persist search filters and query across sessions**~~ — FilterState saves termStates/types/statuses to localStorage, SearchState saves lastQuery. App init uses persisted state. Load-more error sets hasMore=false to prevent retry loop. ListView sentinel margin → 500%
20. ~~**Fix reader image flash on scroll**~~ — Observer was created with null root (fell back to viewport, ignoring rootMargin). Now defers creation via getRoot getter + pending queue. Unified all rootMargins to 500% (images + both sentinels), extended reload range to ±MAX_CHAPTER_DISTANCE
19. ~~**Eight-part quality refactor**~~ — Type safety (eliminate `any`), magic number extraction to constants.ts, memoized `$derived.by` in ChapterList/FilterPanel, PageTracker extraction from Reader, standardized observer patterns (ListView sentinel), ProgressState O(1) update, ConnectionMonitor cleanup, IndexedDB error logging
18. ~~**Fix scroll position save + auto-scroll to current chapter in manga details**~~ — `trackVisiblePage` in-memory + `flushVisiblePage` on close, `scrollIfCurrent` action in ChapterList, manga view scroll reset on open
17. ~~**Fix prepend sentinel + add scroll position restoration**~~ — Sentinel actions now use deferred activation (`getRoot` + `disabled`), `observeChapterBoundary` recreates observer on root change, scroll position saved/restored via IndexedDB `pageIndex`
16. ~~**Five-part refactor: fetchJson wrapper, sentinel action, DOM access cleanup, storage utility, FilterState extraction**~~ — api.ts fetchJson with error classification + retry, use:sentinel action, bind:this context for reader root + pageDataMap replacing __readerData, storage.ts typed helpers, FilterState class extracted from SearchState
11. ~~**Refactor Reader.svelte into smaller pieces**~~ — Extracted `observePageImages` and `observeChapterBoundary` Svelte actions, moved history sync to `ReaderState.syncChapterProgress()`, Reader.svelte 245→147 lines
10. ~~**Error handling & request management refactor**~~ — AbortController in search, toast errors, centralized NSFW IDs, typed Reader DOM access
9. ~~**Extract reusable FilterChip component**~~ — `FilterChip.svelte` with scoped CSS, replaces inline chip markup in FilterPanel and ChapterList
8. ~~**Extract blob/memory management from Reader.svelte into ReaderMemoryManager.ts**~~ — plain TS class, Reader.svelte passes elements to manager
7. ~~**Split state.svelte.ts into separate modules**~~ — 7 files under `src/lib/state/`, constructor-injected cross-state deps
2. ~~**Implement full app resume lifecycle**~~ — ConnectionMonitor + WatchdogService + iOS sentinel, view-aware refresh
1. ~~**Add empty filler rows to manga details**~~ — Fixed with `min-height: 100%` on `.manga-view` so swipe-back works on full viewport
3. ~~**Save last selected group per manga**~~ — localStorage keyed by `group:{slug}`
4. ~~**Multiple group selections**~~ — Toggle chips on/off, stored as JSON array
5. ~~**Bold current/reading chapter**~~ — Green left border + bold green chapter number
6. ~~**Reduce wasted space on margins and titles**~~ — Edge-to-edge covers, text overlaid on cover
