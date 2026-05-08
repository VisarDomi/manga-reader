# Swipe Jank Ownership TODO

## Goal

Remove the reactive work that makes all swipe gestures feel heavy after opening
manga detail from search or favorites. Work point by point; after each point,
rebuild/restart, let the user test, then check logs before moving on.

## Evidence

- Restore into reader/comments is relatively light: it loads only the chapter
  index needed for the reader path and defers background work while reader or
  comments are foreground.
- Opening manga detail from favorites/search is heavy: a large manga triggers
  `chapters-parallel`, then repeated `manga-entry-state` writes as `chapters`
  grows toward thousands of items.
- After that detail open, logs show repeated `reader-frame-gap` events during
  reader/comments gestures. The issue is consistent with broad Svelte reactive
  invalidation, not slow network.

## Svelte 5 Constraints

- Avoid `$state` writes from high-frequency or high-volume producers.
- Avoid broadcast `$state` that wakes many component instances for one keyed
  value change.
- Keep gesture periods quiet: direct DOM/CSS var movement only works if other
  reactive work is not rewriting the view mid-gesture.
- `$derived` chains amplify broad `$state` writes.
- `$effect` and RAF-triggered DOM scans should not become background work that
  competes with active gestures.

## Plan

1. [completed] Make manga chapter ingestion ownership explicit.
   - Keep the growing raw chapter list in a non-reactive owner while pages load.
   - Commit `entry.chapters` only at deliberate display snapshot points.
   - Page 1 remains immediate so the visible top of manga detail appears fast.
   - Final full list commit happens once, not once per returned page.
   - Logs should show far fewer `manga-entry-state phase=chapters-page` events.

2. [completed] Split chapter-list derived work from broad entry changes.
   - Reduce repeated full scans in `ChapterList.svelte`.
   - Make filtering/group/gap calculations owned by a memoized chapter-list
     view model or by `MangaState`, not scattered derived chains.
   - Verify that opening a 3k chapter manga does not keep invalidating all
     chapter-list computations during unrelated gestures.

3. [completed] Fix broadcast progress/chapterStats subscriptions in manga cards.
   - `MangaCoverCard` should not subscribe every card to whole progress/stats
     records.
   - Replace broad reactive reads with keyed snapshots, keyed subscriptions, or
     parent-owned projected card state.
   - Verify progress saves no longer wake the visible card grid.

4. [pending] Audit reader-visible observations that write manga state.
   - `trackVisiblePage` currently writes `currentChapterId` and calls
     `manga.updateScrollTarget`.
   - Keep reader observation as reader-owned hot data; commit manga-detail
     scroll target only at discrete, needed boundaries.
   - Verify reader scroll/momentum does not cause manga-detail state writes.

5. [pending] Audit list/favorites visible-prewarm scanning.
   - `MangaList` scans DOM rects in RAF after scroll and when manga IDs change.
   - Ensure this work only runs when the owning list view is active and does not
     compete with swipe gestures or foreground reader/comments.

6. [pending] Make logs prove ownership boundaries.
   - Add targeted logs only where needed: state commit counts, skipped/queued
     background work, and gesture-time reactive work.
   - Logs should answer whether a jank window had chapter commits, card-grid
     broadcasts, reader observation commits, or list prewarm scans.
