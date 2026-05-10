# Infinite Manga Reader Architecture Research

Date: 2026-05-10

## Scope

This report looks at how other manga/comic readers and virtual scrolling systems handle continuous readers, dynamic page loading, and scroll stability. The goal is to sanity-check our current reader direction after rare black-screen/jump bugs in the bounded physical scroller.

Reference material checked:

- Local: `/home/visar/Documents/reference/TachiyomiSY`
- Local: `/home/visar/Documents/reference/yomikiru`
- Local: `/home/visar/Documents/reference/teemii`
- Local: `/home/visar/Documents/reference/go-reader`
- Local: `/home/visar/Documents/reference/virtual` (TanStack Virtual)
- Local: `/home/visar/Documents/reference/react-virtuoso`
- Web: WebKit bugs around momentum/prepend scrolling

## Short Verdict

The reader bugs we are seeing are a known class of problem: continuous manga readers are easy when all content is rendered in one static document, but they become fragile when the app virtualizes content, prepends previous content, changes measured heights, or writes `scrollTop` while the browser is still scrolling.

The stronger architecture is not another guard. It is a stricter ownership model:

- one owner computes the scroll model,
- one committed frame owns all physical geometry,
- DOM scroll writes only target a rendered frame,
- image loading consumes the committed frame but does not own layout,
- visibility/progress are observations, never layout authority.

Our current `ReaderWindowFrame` direction matches the best pattern found in mature virtualizers. The part that must stay strict is atomicity: physical start, physical height, slot positions, slot heights, mounted slot membership, and scroll target must move together.

## What Mature Manga Readers Do

### TachiyomiSY Webtoon Reader

Files:

- `/home/visar/Documents/reference/TachiyomiSY/app/src/main/java/eu/kanade/tachiyomi/ui/reader/viewer/webtoon/WebtoonViewer.kt`
- `/home/visar/Documents/reference/TachiyomiSY/app/src/main/java/eu/kanade/tachiyomi/ui/reader/viewer/webtoon/WebtoonAdapter.kt`
- `/home/visar/Documents/reference/TachiyomiSY/app/src/main/java/eu/kanade/tachiyomi/ui/reader/viewer/webtoon/WebtoonLayoutManager.kt`
- `/home/visar/Documents/reference/TachiyomiSY/app/src/main/java/eu/kanade/tachiyomi/ui/reader/loader/HttpPageLoader.kt`

Tachiyomi's webtoon mode is built on Android `RecyclerView`, not a manually maintained giant DOM. That matters because RecyclerView has one layout manager that owns item positions and scroll state.

Important patterns:

- The adapter builds one ordered item list containing previous chapter pages, transition item, current chapter pages, next transition, and next chapter pages.
- Changes are applied through `DiffUtil`, so the list changes as a dataset transaction rather than scattered DOM edits.
- `WebtoonLayoutManager` uses extra layout space and explicitly disables item prefetch because the reader wants holders laid out early enough to avoid black views.
- Page selection is observation from the layout manager's visible item positions.
- Preloading next/previous chapters is a side effect of selected pages/transitions, not an owner of scroll geometry.
- Page image loading uses a priority queue in `HttpPageLoader`; current page has higher priority, following pages have lower priority.

What applies to us:

- The webtoon reader has a single layout manager. Our equivalent should be `ReaderWindowManager` plus a committed `ReaderWindowFrame`.
- Chapter preloading should remain an output of the frame/probe, not something that mutates geometry directly.
- Visibility should update progress/title/preload, but must not change layout authority.

What does not directly apply:

- RecyclerView owns native scroll physics and recycling. A web PWA does not get this for free, especially on iOS Safari.

### Yomikiru

Files:

- `/home/visar/Documents/reference/yomikiru/src/renderer/features/reader/manga/Reader.tsx`
- `/home/visar/Documents/reference/yomikiru/src/renderer/features/settings/components/GeneralSettings.tsx`
- `/home/visar/Documents/reference/yomikiru/src/renderer/utils/readerSettingsSchema.ts`

Yomikiru is useful mostly as a warning. It has a vertical scroll reader, but its dynamic image loading setting explicitly warns that dynamic loading can cause inconsistent scroll size and stuttering while scrolling. It also has a canvas-based rendering mode described as smoother for high-res images, with the tradeoff of high RAM and less sharp images.

Patterns:

- It often loads the full chapter image list first.
- It tracks page number from visible DOM.
- It restores page by `scrollIntoView`.
- Dynamic loading is optional and documented as risky for scroll stability.
- It has a setting note that focusing current chapter in a large side list can cause huge performance loss.

What applies to us:

- Dynamic loading that changes scroll size during reading is inherently fragile.
- If we want infinite cross-chapter scroll, the browser must see stable geometry before the user reaches it.
- Heavy sibling UI can hurt reader feel even if reader code is correct.

What does not apply:

- Yomikiru is desktop Electron/local files. It does not solve iOS Safari momentum behavior.

### Teemii

Files:

- `/home/visar/Documents/reference/teemii/app/src/views/chapter.vue`
- `/home/visar/Documents/reference/teemii/app/src/components/page.vue`

Teemii's reader is simpler. It loads one chapter, lazy-loads images by replacing `data-src`, updates visible page, and navigates previous/next chapter by route reload.

What applies to us:

- It avoids the hardest case by not keeping a seamless cross-chapter virtual runway.
- The simplicity is stable because it does not constantly rebase a physical scroller.

What does not apply:

- It is not trying to solve our feature: fast continuous scroll across many chapters.

### go-reader

Files:

- `/home/visar/Documents/reference/go-reader/core/Streamer.gd`
- `/home/visar/Documents/reference/go-reader/core/Tex.gd`
- `/home/visar/Documents/reference/go-reader/Main.gd`

go-reader uses a game-engine camera and texture nodes. It streams pages around the current camera position with buffers and unloads textures outside the buffer.

Important patterns:

- The camera position is the reader cursor.
- Page objects are streamed in a buffer around current page.
- Jumping is treated as a special mode with explicit post-jump loading before normal streaming resumes.
- Unloading is based on distance from current page, not on arbitrary DOM visibility.

What applies to us:

- The owned cursor should be logical/camera-like, not browser `scrollTop`.
- Jump/rebase should be an explicit transaction mode.
- Loading/unloading should be relative to the owned cursor/frame.

What does not apply:

- A game engine camera avoids browser scroll anchoring/momentum entirely. We cannot take that route without rewriting gestures/scroll physics.

## What Virtual Scrolling Libraries Teach

### TanStack Virtual

Files/docs:

- `/home/visar/Documents/reference/virtual/packages/virtual-core/src/index.ts`
- https://tanstack.com/virtual/latest/docs/api/virtualizer
- https://tanstack.com/virtual/latest/docs

Relevant ideas:

- A virtualizer owns the scroll model.
- It exposes `scrollToOffset` and `scrollToIndex`, with alignment as part of the model.
- Dynamic sizes require explicit measurement and optional scroll adjustment policy.
- It has `shouldAdjustScrollPositionOnItemSizeChange`, which is effectively an ownership hook for height changes.
- It recommends block translation for smooth scrolling because measuring only a buffered range can otherwise shift target positions.

What applies to us:

- Height measurement cannot directly mutate DOM scroll state. It must go through the virtualizer owner.
- Scroll adjustment is a policy owned by the scroll model, not a local component fix.
- Rendered block/slot geometry must be coherent as one model.

### React Virtuoso

Files/docs:

- `/home/visar/Documents/reference/react-virtuoso/packages/react-virtuoso/src/`
- https://virtuoso.dev/react-virtuoso/

Relevant ideas:

- It supports variable item sizes automatically.
- It has prepend/load-more behavior that retains scroll position.
- This is presented as a first-class virtualizer behavior, not an app-level afterthought.

What applies to us:

- Prepend and dynamic item size are core virtualizer responsibilities.
- Our app should not scatter prepend compensation or scroll writes through reader/image/progress code.

## iOS/WebKit Constraints

References:

- https://bugs.webkit.org/show_bug.cgi?id=187449
- https://bugs.webkit.org/show_bug.cgi?id=285306
- https://safari-ios-getboundingclientrect-scroll-bug.glitch.me/

Relevant findings:

- WebKit has had issues setting `scrollTop` during momentum scroll. The reported behavior is that setting `scrollTop` during momentum can cause jitter or fail to preserve momentum.
- A recent WebKit bug reports prepending into a scroll container causing scroll to jump to newly inserted content, while Chrome/Firefox preserve the visible child.
- `getBoundingClientRect()` readings can fluctuate on iOS Safari during scroll in certain layouts.

What applies to us:

- Avoid programmatic `scrollTop` writes during active momentum unless they are unavoidable and tied to a rendered frame.
- Avoid prepending/slot movement as unowned DOM changes.
- Logs should not over-trust raw rect readings without also logging frame epoch and slot ranges.

## Pattern Behind Our Bugs

Both black-screen/jump failures share the same shape:

1. The user is reading normally.
2. The reader internally changes the physical scroll model.
3. One piece of state moves before another related piece.
4. The browser viewport lands in a coordinate space not covered by current DOM pages.

In the first black-screen bug, logical cursor ownership was wrong. The planner mixed a new physical window start with an old physical `scrollTop`, producing a bogus logical jump and revoking the visible images.

In the second black-screen bug, the logical cursor was coherent, but frame geometry was not atomic. `physicalWindowStart` changed and `scrollTop` was written while slot geometry could still reflect the previous physical frame. Logs showed `registeredPages=120` and `visiblePages=0`, which means the problem was not network or image fetch. The DOM had pages; the viewport was in a gap.

## Architecture Recommendation

The best architecture for this app is a browser-scroll-preserving virtualizer, not a synthetic scroller and not a full rewrite.

### Ownership Boundaries

`ReaderWindowManager`

- Pure planner.
- Inputs: chapter list, known page/chapter heights, logical cursor, viewport, current physical window.
- Output: full `ReaderWindowFrame`.
- No DOM writes.
- No image loads.
- No progress writes.

`ReaderState`

- Owns the logical cursor and committed frame.
- Commits the whole frame atomically.
- Owns height measurement promotion policy.
- Owns fetch priority decisions derived from the frame.

`Reader.svelte`

- Owns DOM observation and DOM scroll writes.
- Applies a scroll write only after the matching frame epoch has rendered.
- Reports measurements/visibility as facts.

`ReaderMemoryManager`

- Owns image blob lifecycle.
- Consumes mounted page geometry after render.
- Never changes frame geometry.

`PageTracker`

- Owns progress observation.
- Never changes layout.

### Frame Shape

A reader frame should contain:

- `epoch`
- `logicalScrollTop`
- `physicalWindowStart`
- `physicalScrollTop`
- `physicalHeight`
- `slots[]`
- each slot's `chapterId`, `slotState`, `logicalTop`, `logicalHeight`, `virtualTop`, `virtualHeight`, page count
- `wantedIds`
- fetch candidates

If any render-relevant field changes, it is a new frame. Chapter IDs alone are not enough.

### Rebase Transaction

Correct flow:

1. Read current browser scroll.
2. Convert to logical cursor using the currently committed frame.
3. Plan next frame.
4. Commit next frame atomically.
5. Wait for Svelte/DOM render.
6. If the frame epoch still matches, write physical `scrollTop`.
7. Schedule images from the rendered frame.
8. Log coverage.

Incorrect flow:

1. Change `physicalWindowStart`.
2. Keep old slots because IDs did not change.
3. Write `scrollTop` immediately.
4. Let DOM catch up later.

That incorrect flow is how a viewport can land in a black gap.

## What To Avoid

- Guarding visible chapter saves instead of fixing layout ownership.
- Treating prepend as a local DOM operation.
- Letting image loading decide layout.
- Writing `scrollTop` before the target frame renders.
- Measuring heights and applying scroll compensation from multiple places.
- Using `loadedChapters` as both data cache and render-frame geometry forever.
- Trusting item IDs as the only render-change signal.
- Rebuilding toward a synthetic scroller unless browser scroll physics become impossible.

## Stronger Future Direction

The current frame-epoch fix is the right near-term architecture. If bugs continue, the next step should not be a guard; it should be a fuller separation:

- `chapterDataById`: ready pages and metadata
- `ReaderWindowFrame`: only render geometry
- `fetchQueue`: desired chapter/image work from the frame
- `progressObserver`: visible page facts

That would remove the remaining ambiguity where `loadedChapters` still acts as both loaded data and render slot list.

The even larger alternative is a game-engine-style logical camera/synthetic scroller. That would avoid WebKit scroll bugs but risks breaking native iOS momentum and gestures. It should remain a last resort.

## Practical Test Signals

The logs should prove frame correctness. Useful events:

- `reader-window-frame`
- `reader-scroll-write source=physical-rebase frameEpoch=...`
- `reader-surface-snapshot visiblePages=... visibleSections=... frameEpoch=...`
- `reader-window-coverage-miss`

Failure signature to watch:

- `registeredPages > 0`
- `pageElements > 0`
- `visiblePages = 0`
- big `physicalStartDelta`
- scroll write near the same timestamp

If that appears again, the bug is still frame coverage/atomicity. If `visiblePages > 0` but `visibleLoadedImages = 0`, then the bug moved to image scheduling/cache. If both are zero and there are no page elements, then the bug moved to fetch/window membership.
