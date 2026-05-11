# Reader Ownership Leak Fix Plan

Goal: stop reader flashes and false chapter/progress changes without gating scroll momentum. The bug at `2026-05-11 00:29:18` showed a physical rebase where the rendered DOM still showed chapter `7523507`, but progress briefly observed chapter `7523502`. That means observers were reading planned/cache geometry instead of the committed rendered frame.

## Ownership Rules

- Browser scroll remains the scroll engine.
- Gesture actions remain the gesture engine.
- `ReaderState` owns committed render-frame geometry.
- `ReaderWindowManager` owns pure planning only.
- DOM visibility owns visible-page/progress facts.
- `ReaderMemoryManager` owns image blob lifetime only.
- Image cleanup may not destructively remove mounted image sources during scroll/rebase.
- Active scroll is a restricted phase:
  - no physical-window rebase,
  - no top/bottom slot retirement,
  - no image blob revoke or `img.src` removal.
- Initial/idle transactions are the only normal owners of destructive projection work.

## Implementation

1. Split rendered geometry from planner geometry.
   - `ReaderState.pageGeometry()` must describe the committed `loadedChapters` render projection only.
   - Planner/cache data in `chapterDataById` can feed layout planning, but cannot feed visibility or image scheduling directly.

2. Make visible progress DOM-owned.
   - `PageTracker` should observe mounted `.reader-page` elements through `ReaderMemoryManager.pageDataMap`.
   - If a page is not mounted, it cannot become the visible chapter.
   - This prevents false chapter changes during physical rebase.

3. Make image cleanup lease-based.
   - Image scheduling may start nearby images immediately.
   - Pages that leave the image window become retired candidates.
   - Actual blob revoke and `img.src` removal happens only after a grace period and only if the page is still outside the window.
   - This is not a chapter-unload gate; it is image-memory ownership so scroll/rebase cannot flash visible images to black.

4. Keep logs at the ownership boundary.
   - `reader-image-schedule-perf` should still report revoked counts.
   - `reader-surface-snapshot` should prove mounted/visible pages and loaded images.
   - Bad signature after this fix: DOM-visible pages report one chapter while `reader-chapter-change` reports another.

5. Make active scrolling non-destructive.
   - `ReaderState` tracks `idle | scrolling | programmatic` activity.
   - `reconcileReaderWindow('scroll')` keeps the current physical runway start and preserves all mounted slots.
   - Idle reconciliation may compact/rebase after scroll activity stops.
   - `ReaderMemoryManager` can hydrate images while scrolling, but cleanup is disabled until idle.

## Validation

- `npm run restart`
- Check logs around a fast reader scroll/rebase:
  - no false `reader-chapter-change` to a non-mounted chapter
  - no `reader-scroll-write source=physical-rebase` while `reader-scroll-activity` is `scrolling`
  - no image `revoked` count while scroll is active
  - no `reader-window-coverage-miss`
  - `reader-image-schedule-perf pages` should match rendered-frame pages, not all planner/cache pages
  - `visiblePages > 0` and `visibleLoadedImages > 0` after rebase
