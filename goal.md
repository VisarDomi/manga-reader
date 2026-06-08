# Goal: Fix Native Document Scroll Back-Stack Position Leaks

## Context

Pass 1 moved Search/Favorites/Providers/Manga detail/Chapter comments toward
native document scrolling for Safari iOS 27 browser chrome behavior. User
validated that the main behavior works except Reader, but found two scroll
ownership leaks:

- Reader -> Manga detail swipe-back: during the peek, Manga detail is at the
  correct saved position, but after the swipe commits, it jumps to top.
- Manga detail -> Search root swipe-back: during peek, Search is still at top,
  but after commit it scrolls to the target manga. The commit-time handoff is
  better; the peek-time backing layer is still not owned correctly.

These are not Reader migration tasks. They are back-stack/document-scroll
ownership bugs caused by moving foreground surfaces to document scroll while
backing layers still carry element scroll state.

## Checklist

- [x] Commit and push the validated Pass 1 checkpoint.
- [x] Check logs from the latest service start and user test for `view-pop`,
  `manga-scroll-save`, `manga-scroll-restore`, search restore/list scroll, and
  swipe state.
- [x] Trace current code ownership for scroll snapshots:
  - [x] Manga detail scroll persistence.
  - [x] Search/list visible target or scroll persistence.
  - [x] `useDocumentScroll` toggling during swipe start/finish.
  - [x] `view-layer.document-scroll` interaction with hidden/back layers.
- [x] Fix Reader -> Manga commit jump:
  - [x] Preserve the backing Manga detail scroll when document-scroll toggles
    off during swipe and back on after commit.
  - [x] Ensure commit does not reset document scroll to zero when Manga becomes
    foreground.
  - [x] Use `$effect.pre` for the capture side of scroll ownership handoff,
    because normal `$effect` runs after DOM/class changes.
- [ ] Fix Manga -> Search peek already-at-top:
  - [x] Identify whether Search root saves scroll as target-id only or pixel
    scroll.
  - [ ] Restore Search root position before/during peek, not only after it
    becomes foreground.
- [x] Build/restart with repo command.
- [x] User Safari validation: better after commit-time handoff, but still
  broken during swipe peek.
- [ ] Decide next architecture for swipe-time document-scroll ownership.

## Constraints

- Do not start Reader document-scroll migration in this batch.
- Do not add timer gates. Preserve ownership: the active/backing surface that
  owns scroll state must provide the scroll position before it is revealed.
- Keep root Search and Favorites exclusive.
