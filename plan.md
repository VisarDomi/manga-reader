# Reader Virtual Window Separation Plan

Goal: keep native browser scroll and iOS momentum, while making fast continuous scroll across many chapters stable. The app should not invent a gesture/scroll engine. It should own the virtual window model tightly enough that the browser always sees a coherent rendered frame.

## Constraints

- Browser scroll remains the scroll engine.
- Gesture code remains the gesture engine.
- Reader layout has one writer: `ReaderState` commits a full `ReaderWindowFrame`.
- `ReaderWindowManager` stays pure: it plans geometry and candidates, but does not fetch, observe, or write DOM.
- Images, progress, and visible-page tracking consume the committed frame. They do not own geometry.

## Implementation

1. Split ready chapter data from render-frame slots.
   - Add `chapterDataById` for ready pages/metadata.
   - Keep `loadedChapters` as the Svelte render projection of the committed frame, not the data cache.

2. Make `ReaderWindowFrame` explicit.
   - Frame owns epoch, logical cursor, physical window start/height, physical scroll target, and slot geometry.
   - Any render-relevant geometry/page-state change creates a new frame epoch.

3. Commit frames atomically.
   - Physical start, virtual height, render slots, frame signature, and frame epoch move together.
   - DOM scroll writes still happen only after the matching epoch renders.

4. Keep fetches derived from the frame.
   - Window candidates start priority fetches.
   - Successful fetches populate `chapterDataById`.
   - The render projection updates by merging ready data into the current frame slot without owning layout.

5. Keep measurement promotion owned by the frame path.
   - Measurements update height estimates.
   - Repositioning goes through the same frame/projection machinery.

## Validation

- Build/restart with `npm run restart`.
- Logs to watch:
  - `reader-window-frame`
  - `reader-scroll-write source=physical-rebase frameEpoch=...`
  - `reader-surface-snapshot`
  - `reader-window-coverage-miss`
- Bad signature remains: `registeredPages > 0`, `pageElements > 0`, `visiblePages = 0` near a big physical rebase.
