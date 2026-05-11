# Infinite Manga Reader Architecture Research

Date: 2026-05-11

## Scope

This report records the reference work behind the current reader architecture.
It is not a generic survey of manga apps. The product constraint is specific:
keep native browser/iOS momentum scrolling while supporting fast continuous
scroll across many chapters without black flashes, false chapter changes, or
giant browser scroll surfaces.

Reference material checked locally:

- `/home/visar/Documents/reference/TachiyomiSY`
- `/home/visar/Documents/reference/yomikiru`
- `/home/visar/Documents/reference/teemii`
- `/home/visar/Documents/reference/go-reader`
- `/home/visar/Documents/reference/virtual` (TanStack Virtual)
- `/home/visar/Documents/reference/react-virtuoso`

Current app files checked while refreshing this report:

- `packages/app/src/lib/state/reader.svelte.ts`
- `packages/app/src/lib/services/ReaderWindowManager.ts`
- `packages/app/src/lib/services/ReaderMemoryManager.ts`
- `packages/app/src/lib/components/Reader.svelte`

## Current Verdict

The current reader direction is still the right one: a browser-scroll-preserving
virtualizer with strict ownership boundaries. The older report described a
future `ReaderWindowFrame`-style direction. The shipped code now implements the
important part of that direction differently: the committed render projection
owned by `ReaderState` is the authority, and planner/cache geometry is only an
input for future work.

The key correction from the latest black-screen bugs is this:

- planner geometry can request work
- mounted DOM geometry can report visible facts
- image memory can hydrate or release bytes
- only the reader state owner can commit physical scroll geometry

Anything else risks landing Safari's viewport in a coordinate space that the
DOM has not rendered yet.

## What Mature Manga Readers Prove

### TachiyomiSY Webtoon Reader

Relevant files:

- `app/src/main/java/eu/kanade/tachiyomi/ui/reader/viewer/webtoon/WebtoonViewer.kt`
- `app/src/main/java/eu/kanade/tachiyomi/ui/reader/viewer/webtoon/WebtoonAdapter.kt`
- `app/src/main/java/eu/kanade/tachiyomi/ui/reader/viewer/webtoon/WebtoonLayoutManager.kt`
- `app/src/main/java/eu/kanade/tachiyomi/ui/reader/loader/HttpPageLoader.kt`

TachiyomiSY uses Android `RecyclerView`. That gives it something the web app
does not get for free: a native layout manager that owns recycling, visible
positions, and scroll state.

Useful patterns:

- The adapter builds a single ordered item list from previous chapter pages,
  transition items, current chapter pages, next transition, and next chapter
  pages.
- Updates go through `DiffUtil`, so dataset changes are transactions rather
  than scattered view mutations.
- The layout manager owns visible item positions. Page selection is observation
  from the layout manager, not layout authority.
- Preloading next/previous chapters is a side effect of visible position and
  transition pages.
- Image loading has priority, but it does not own layout.

What applies to this app:

- We need a single reader layout owner.
- Visibility/progress may observe, but must not mutate layout.
- Chapter preloading is derived from the current layout/cursor, not a separate
  geometry writer.
- Image loading should follow the committed render model.

What does not apply directly:

- RecyclerView solves native recycling and scroll physics on Android. iOS
  Safari does not give this app the same guarantee.

### Yomikiru

Relevant files:

- `src/renderer/features/reader/manga/Reader.tsx`
- `src/renderer/features/settings/components/GeneralSettings.tsx`
- `src/renderer/utils/readerSettingsSchema.ts`

Yomikiru is mostly useful as a warning. Its vertical reader has settings around
dynamic loading and smoother rendering modes, and those settings acknowledge
that dynamic loading can cause inconsistent scroll size and stutter.

What applies:

- Changing scroll size during reading is inherently fragile.
- If the app wants continuous cross-chapter scroll, stable geometry has to be
  prepared before the user reaches it.
- Heavy sibling UI can make the reader feel worse even when reader code is not
  the direct bug owner.

What does not apply:

- Yomikiru is a desktop Electron/local-file app. It is not solving iOS PWA
  momentum constraints.

### Teemii

Relevant files:

- `app/src/views/chapter.vue`
- `app/src/components/page.vue`

Teemii uses a simpler model: one chapter view, lazy image loading, visible page
tracking, and route navigation for previous/next chapters.

What applies:

- Simpler readers are stable partly because they avoid the hard problem.
- If only one chapter is mounted, there is no giant cross-chapter virtual
  runway to keep coherent.

What does not apply:

- The current app intentionally wants fast continuous scrolling through many
  chapters, so Teemii's route-per-chapter design does not satisfy the core
  product behavior.

### go-reader

Relevant files:

- `core/Streamer.gd`
- `core/Tex.gd`
- `Main.gd`

go-reader uses a game-engine camera and streamed texture nodes. The camera is
the cursor; pages are loaded and unloaded around the camera with a buffer.

What applies:

- The owned cursor should be logical/camera-like.
- Jump/rebase should be an explicit transaction.
- Loading and unloading should be relative to the owned cursor, not arbitrary
  observer timing.

What does not apply:

- A game camera avoids browser scroll anchoring and iOS momentum entirely. That
  would mean replacing native browser scroll/gestures, which is a last resort
  for this app.

## What Virtualizers Prove

### TanStack Virtual

Relevant file:

- `packages/virtual-core/src/index.ts`

Important patterns:

- The virtualizer owns scroll offset, measured item sizes, range extraction,
  overscan, and scroll-to behavior.
- Scroll observation reports offset and an `isScrolling` phase.
- Resize observation can be deferred through animation frame when needed.
- Dynamic size changes go through virtualizer policy such as scroll adjustment,
  not local component compensation.

What applies:

- Measurement is input to the scroll model, not a direct DOM scroll mutation.
- Active scrolling is a distinct phase, and expensive/destructive projection
  should respect it.
- Range extraction and overscan belong to the virtualizer owner.

### React Virtuoso

Relevant files:

- `packages/react-virtuoso/src/listStateSystem.ts`
- `packages/react-virtuoso/src/domIOSystem.ts`
- `packages/react-virtuoso/src/sizeSystem.ts`
- `packages/react-virtuoso/src/scrollToIndexSystem.ts`

Important patterns:

- The system is split into small owners: DOM IO, sizes, list state, scrolling
  state, scroll-to-index, recalc.
- `listStateSystem` builds one coherent state containing visible items,
  offsets, top/bottom spacers, total count, and first item index.
- `domIOSystem` owns scroll container readings and scroll write streams.
- Dynamic measurement and scroll changes are coordinated through streams rather
  than scattered local effects.

What applies:

- Split owners by resource, not by convenience.
- List state should contain the coherent render projection, not just item IDs.
- DOM IO should be a boundary. It reports measurements and applies scroll
  writes; it should not own product policy.

## iOS/WebKit Constraints

Observed and previously tested constraints:

- Prepending content while scrolling can jump the viewport on iOS Safari.
- Setting `scrollTop` during momentum can break the user's flow even when the
  numeric target is mathematically correct.
- `getBoundingClientRect()` during active scroll should be treated as an
  observation, not a source of ownership.

These constraints are why the app cannot fix reader bugs by adding another
guard near progress saves. The important question is always: did the reader
change physical geometry, image ownership, or visible authority while Safari
was still scrolling?

## Pattern Behind Our Reader Bugs

The hard failures have had the same shape:

1. User is reading normally.
2. Reader changes internal virtual/physical state.
3. One owner observes or cleans up against a geometry version that has not
   become the committed rendered frame.
4. The viewport lands in a gap, or visible images are removed, or progress
   briefly reports a chapter that is not actually mounted.

Concrete examples from the recent work:

- A physical rebase mixed a new physical window start with old scroll/slot
  assumptions. The result was a logical jump and a black screen.
- Planner/cache geometry made non-mounted pages look eligible for progress or
  image scheduling. That created false chapter observations.
- Image cleanup could revoke blob URLs while scroll/rebase was still active,
  causing a visible flash even though network/cache was not the bug.

## Current Shipped Architecture

The current architecture is a bounded physical scroller over a logical manga
coordinate space.

### ReaderState

Owns:

- logical cursor
- physical window start
- physical scroll projection
- committed render slots
- active scroll phase: `idle`, `scrolling`, `programmatic`
- rebase/destructive projection policy

During active scroll, `reconcileReaderWindow('scroll')` is non-destructive. It
keeps the current physical runway start and preserves mounted slots. Idle or
initial transactions can rebase and compact.

### ReaderWindowManager

Owns pure planning:

- full logical chapter layout
- wanted chapter candidates
- DOM keep window
- virtual top/height calculations
- placeholder slot creation

It does not own DOM, image memory, progress, or scroll writes. Its plan can
request work, but it cannot become a visible fact until `ReaderState` commits
the render projection.

### Reader.svelte

Owns DOM observation and DOM scroll writes:

- reads scroll container state
- registers page DOM nodes
- reports measurements and visible facts
- applies programmatic scroll writes after the reader owner asks for them

It should not invent layout policy.

### ReaderMemoryManager

Owns image blob lifetime:

- page DOM node registration
- image scheduling inside the image window
- blob URL creation/reuse
- cleanup when allowed by reader state

It consumes committed page geometry from `ReaderState.pageGeometry()` and
mounted DOM facts from `pageDataMap`. Cleanup is disabled during active scroll.
That is ownership, not a blind delay: active scroll is the phase where image
cleanup can visually destroy a still-relevant frame.

### PageTracker

Owns visible progress observation:

- observes mounted `.reader-page` DOM nodes
- prefers layout/current chapter hints only as tie-breakers
- never promotes a non-mounted planner/cache page into visible progress

This is the important correction from the previous architecture. Visibility is
DOM-owned, not planner-owned.

## What Changed Since the Older Report

The older report recommended a fuller `ReaderWindowFrame` object with epoch,
slots, scroll target, and coverage. The current code uses a lighter version of
that idea:

- `ReaderState` commits render-relevant slot geometry through
  `commitWindowFrame`.
- `ReaderWindowManager.plan()` can preserve existing loaded slots when
  destructive projection is not allowed.
- `ReaderState.pageGeometry()` reads the committed render projection, not all
  planner/cache data.
- `ReaderMemoryManager.loadVirtualWindow(..., { allowCleanup })` hydrates
  images during scroll but skips cleanup when active.
- `Reader.svelte` passes `memory.pageDataMap` to page tracking, so mounted DOM
  nodes own visible-page facts.

This means the code no longer exactly matches the old "future direction"
language. The architectural intent remains the same, but the shipped
implementation is now stricter about committed render geometry and active
scroll non-destruction.

## What To Avoid

- Guarding progress saves to hide false chapter changes.
- Treating prepending/removing content as a local DOM operation.
- Letting image cleanup decide what the reader can safely show.
- Writing `scrollTop` while scroll activity is active unless it is an explicit
  programmatic transaction.
- Using planner/cache pages as visible-page authority.
- Using a delay gate as the primary fix. A delay can hide symptoms, but the
  owner still has to know whether cleanup/projection is allowed.
- Replacing native scroll with a synthetic/game-engine scroller unless browser
  scroll physics become impossible.

## Remaining Risk

The reader has not been fully revalidated on the user's iPhone after the latest
ownership changes. `plan.md` remains intentionally present for that reason.

Good signatures in logs:

- no `reader-scroll-write source=physical-rebase` while
  `reader-scroll-activity` is `scrolling`
- no false `reader-chapter-change` to a non-mounted chapter
- `reader-image-schedule-perf revoked=0` while active scroll cleanup is
  disabled
- `reader-surface-snapshot visiblePages > 0` and `visibleLoadedImages > 0`
  after rebase
- no `reader-window-coverage-miss`

Bad signatures:

- `registeredPages > 0`, `pageElements > 0`, `visiblePages = 0`
- a physical rebase and a black flash in the same time window
- `reader-chapter-change` reports a chapter absent from mounted DOM page data
- image revokes happen during `scrolling`

## Final Recommendation

Keep the current ownership split and validate it in the real PWA:

- browser owns native scroll/momentum
- gestures own navigation gestures
- `ReaderState` owns committed reader geometry
- `ReaderWindowManager` plans only
- DOM owns visible facts
- `ReaderMemoryManager` owns image bytes and cleans only when the reader phase
  allows destruction

If another black-screen bug appears, do not add a guard first. Check which
owner crossed a boundary: geometry changed during active scroll, planner data
became visible authority, image cleanup destroyed a visible frame, or DOM
scroll was written before the committed projection existed.
