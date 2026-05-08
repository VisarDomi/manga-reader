# Reader Window Rewrite TODO

Future sessions: read this file before continuing reader scroll/window work. This file is the handoff source of truth for the architectural rewrite.

## Problem

The reader currently uses independent intersection observers:

- top sentinel loads/prepends previous chapter
- bottom sentinel loads/appends next chapter
- chapter boundary observer updates current chapter/progress and triggers image cleanup/reload
- page observer lazy-loads images

This decentralized model breaks down for short chapters and fast scrolls. A large `500%` preload window can span multiple chapter boundaries, so edge loads and current-chapter transitions cascade. Prepending a previous chapter after async load can move the current chapter anchor far below the viewport; composed scroll correction preserves position but can stop iOS momentum.

The desired behavior:

- User can open a chapter from manga details and immediately scroll fast up or down.
- Use a `1000%` / `10x viewport` distance for chapter window and image preloading.
- Short chapters should load multiple previous/next chapters until the 10x window is satisfied.
- Long chapters naturally load fewer chapters because one chapter consumes the window.
- Chapter work should be prioritized by live distance from the viewport and scroll direction.
- Loading should be round-robin around current position, biased toward scroll direction.
- Chapters outside the keep window should unload/cool down to control memory.
- No late prepend should visibly jump the viewport or break momentum.

## Architecture

Replace sentinel-driven edge loading with a single `ReaderWindowManager`.

Ownership boundaries:

- `ReaderWindowManager`: owns loaded chapter slots, desired chapter window, chapter fetch priority, and DOM window mutation requests.
- `ReaderLayoutModel`: owns estimated/measured chapter heights and slot geometry.
- `ReaderImageManager` / existing `ReaderMemoryManager`: owns hot/cold image blob state based on distance.
- `ReaderProgressTracker` / existing `PageTracker`: observes visible page and saves progress, but does not trigger chapter loading.
- `ReaderScrollCoordinator`: only explicit open/restore positioning. It should not own ongoing infinite-reader window management.

No sentinel should own chapter mutation after the rewrite.

## Window Rules

Use viewport-relative radii:

- `CHAPTER_SLOT_RADIUS = 10 * viewportHeight`
- `CHAPTER_FETCH_RADIUS = 10 * viewportHeight`
- `IMAGE_HOT_RADIUS = 10 * viewportHeight`
- `DOM_KEEP_RADIUS = 12 * viewportHeight`
- `IMAGE_KEEP_RADIUS = 14 * viewportHeight`

On scroll:

1. Read `scrollTop`, `clientHeight`, and direction.
2. Compute desired range:
   - `loadTop = scrollTop - 10 * clientHeight`
   - `loadBottom = scrollTop + clientHeight + 10 * clientHeight`
3. Ask layout model which chapter slots intersect that range.
4. Reconcile loaded slots and fetch queue.
5. Reprioritize image hot/cold state.
6. Debounce visible-page progress separately.

## Placeholder / Reserved Space Strategy

For chapters that enter the desired window:

1. Create a chapter slot immediately.
2. If chapter data is not loaded, render a placeholder/reserved layout slot.
3. Fetch chapter pages in priority order.
4. Hydrate the existing slot in place when data arrives.
5. Avoid writing `scrollTop` during active/momentum scroll.

Height estimation order:

1. Exact page dimensions from chapter detail cache, if known.
2. Previous measured chapter average.
3. Manga-wide measured average.
4. Conservative fallback.

If real height differs from placeholder height:

- Reconcile immediately only when slot is far outside the viewport.
- If slot is near/inside active viewport or user is scrolling/momentum, defer height reconciliation until scroll idle.

## Priority Queue

Build candidates from chapters around current viewport.

Priority factors:

- distance from viewport
- scroll direction boost
- side round-robin fairness
- already-fetching penalty
- retry penalty

Round-robin shape:

- idle: nearest previous, nearest next, second previous, second next
- scrolling down: nearest next first, then nearest previous, then continue alternating with down bias
- scrolling up: nearest previous first, then nearest next, then continue alternating with up bias

Recompute priorities on scroll so fast direction changes update almost in real time.

Network completion rule:

- If loaded chapter is still wanted by the current window epoch, hydrate its slot.
- If no longer wanted, keep metadata cached but do not mutate DOM.

## Current Evidence

Logs proved:

- New chapter opens fast because current chapter is prewarmed.
- Previous chapter often loads slower on first attempt.
- When previous chapter is inserted above current chapter, current anchor can move by ~100k px.
- Old regression came from cancelling prepend compensation on user scroll (`97b5403`).
- Composed compensation prevents the anchor jump but stops iOS momentum.
- Test PWA confirmed raw prepend can jump and composed compensation can feel bad.

## Implementation Checklist

1. [done] Keep current logging while rewriting.
2. [done] Add constants for reader window radii (`1000%` / 10x equivalent).
3. [done] Introduce layout slot type that can represent `placeholder`, `loading`, `ready`, `hydrated`, `cold`, `unloaded`.
4. [done] Add `ReaderWindowManager` service with:
   - viewport update
   - desired window calculation
   - priority candidate generation
   - fetch scheduling
   - stale completion handling
5. [done] Change `ReaderState.loadedChapters` to represent window slots or add parallel slot state consumed by `Reader.svelte`.
6. [done] Remove top/bottom sentinel ownership of append/prepend.
7. [done] Replace `handlePrepend` / `handleAppend` with window-manager reconcile calls.
8. [done] Move page image loading to virtual image scheduling in `ReaderMemoryManager`.
9. [done] Rework chapter boundary observer so it only reports stable current chapter/progress, not loading/window mutation.
10. [done] Add cleanup/cooling based on DOM/image keep radius instead of `MAX_CHAPTER_DISTANCE` only.
11. [done] Build and restart service.
12. [ready for manual repro] Use logs to verify:
    - desired window calculation
    - slots created before fetch completion
    - fetch queue ordering
    - stale fetch completions ignored
    - no `scrollTop` writes during normal prepend/append hydration

## Current Implementation Notes

- `ReaderWindowManager` owns desired chapter candidates, priority ordering, DOM keep-slot reconciliation, and virtual slot geometry.
- `ReaderWindowManager` now plans from the global virtual scroll coordinate (`scrollTop`) rather than from the originally opened chapter. The opened/restored chapter is only the initial positioning target; ongoing loading/unloading is owned by the virtual layout window.
- `ReaderState` owns app state, persistence, fetch side effects, and logging orchestration.
- `ReaderMemoryManager` owns page image loading and revokes blob URLs outside the virtual image keep radius.
- `ReaderScrollCoordinator` no longer performs ongoing reader window management; current open/restore positioning is explicit and logged.
- Manual verification still belongs to the tester because the target bug is iOS/PWA scroll behavior.

## Current Dirty Context

Before rewrite, current dirty files include logging and experimental fixes:

- `packages/app/src/lib/components/Reader.svelte`
- `packages/app/src/lib/services/LogService.ts`
- `packages/app/src/lib/services/PageTracker.ts`
- `packages/app/src/lib/services/ReaderScrollCoordinator.ts`
- `packages/app/src/lib/state/reader.svelte.ts`
- `experiments/prepend-pwa-test/*`

Do not accidentally commit/remove unrelated user changes. The test PWA is experimental and separate from the app.

## Known Good Return Point

- 2026-05-08: Commit `41b1894` (`Add reader visual diagnostics`) is the current good-enough baseline before testing measured layout reconciliation / slot height rebasing. Return here if the next architecture direction causes worse reader behavior.
- This baseline includes the reader visual diagnostics in `packages/app/src/lib/components/Reader.svelte` and `packages/app/src/lib/services/LogService.ts`.

## Next Architecture: Idle-Epoch Layout Reconciliation

Live slot-height rebasing during scroll breaks iOS momentum and can move viewport ownership to the wrong chapter. The reader must not mutate the virtual address space while the user is actively scrolling or while Safari momentum is still producing scroll events.

Required ownership model:

- `ReaderWindowManager` owns virtual address space and slot positions.
- `ReaderState` may collect measured content heights during active scrolling, but must not promote those measurements into `virtualHeight` immediately.
- A new idle layout epoch promotes measured heights only after scroll has been quiet long enough.
- The idle promotion must run as one layout transaction:
  - capture the visible page anchor before promotion
  - promote measured heights for ready slots
  - let Svelte commit DOM
  - restore the same page anchor to the same screen Y
  - reconcile the reader window from the resulting scroll position
- During active scroll, fetched chapters may hydrate into existing pinned slots, but the pinned slot height remains stable until the idle layout epoch.
- If active scroll resumes before the idle epoch fires, cancel/defer the epoch.
- Logs must distinguish passive measurement from actual height promotion.

Implementation checklist:

1. [done] Revert live rebase experiment and keep the `41b1894` baseline behavior.
2. [done] Change chapter measurement to report actual child content height, but store it as pending measurement only.
3. [done] Add idle detection in `Reader.svelte` after scroll events.
4. [done] Add `ReaderState.promotePendingMeasurements()` as the single writer that mutates `virtualHeight` from measurements.
5. [done] Implement visible page anchor capture/restore around idle promotion.
6. [done] Log `reader-layout-measurement` for passive measurements and `reader-layout-idle-promote` for actual address-space changes.
7. [done] Build, restart service, and leave manual iOS validation to the user.

## Boundary Ownership Follow-up

Latest logs showed the section overlap was fixed, but page/window ownership still flipped at the chapter boundary while both chapters were visible. The reader must treat chapter visibility as observation, not authority.

- [done] Make visible-page selection owner-first: prefer a page from the existing layout/current owner while that chapter is still visible, then fall back to the probe page only after the owner leaves the viewport.
- [done] Make idle layout anchor selection use the same owner-first rule, so measured-height promotion cannot anchor to the neighboring chapter just because a tall boundary page crosses the probe line.
- [done] Log `reader-layout-anchor-choice` and include selection metadata in `reader-visible-page`, so future logs show whether ownership was retained or transferred.
