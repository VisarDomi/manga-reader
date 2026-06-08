# Goal: Native Safari Scroll Overhaul

## Context

iOS 27 standalone PWA remains broken after reinstall. Safari works correctly
for Search/Favorites/Providers after those root views started using native
document scrolling instead of fixed nested scrollers.

The goal is to reuse that behavior through a shared scroll owner, not through
ad hoc `window.scrollY` patches. Reader is intentionally excluded from the
first pass because it owns bounded physical scrolling, rebases, image
scheduling, progress, restore, and recommendation tail geometry.

## Pass 1: Shared Scroll Root + Lower-Risk Views

Stop after this pass and ask user to test Safari before touching Reader.

- [x] Create this checklist-style `goal.md` so compaction can resume safely.
- [x] Add a small `ScrollRoot` adapter that supports element scrollers and the
  document/window scroller.
- [x] Enable document-scroll shell mode for Manga detail and Chapter comments
  when they are the active foreground view and no swipe animation is active.
- [x] Migrate Manga detail scroll reads/writes to `ScrollRoot`.
  - [x] Active manga detail saves scroll through `ScrollRoot`.
  - [x] Manga detail pixel restore writes through `ScrollRoot`.
  - [x] Reader-recommendation scroll target writes through `ScrollRoot`.
  - [x] Chapter history scroll in `ChapterList.svelte` writes through
    `ScrollRoot`.
  - [x] CSS makes only the active manga detail layer document-flow; hidden and
    swipe-back layers stay layered.
- [x] Migrate Chapter comments to document scroll.
  - [x] Shell document-scroll class is enabled.
  - [x] Surface CSS does not fight document scrolling.
  - [x] Swipe-back is owned by the view layer that gets transformed, not the
    inner comments content.
- [x] Run type/build checks.
- [x] Restart with repo command.
- [x] Check logs from the new service start.
- [x] Stop and report Pass 1 ready for Safari testing.

## Break Point

Do not start Reader migration until user validates Pass 1 in Safari.

## Pass 2: Reader Migration

- [ ] Move Reader to the same scroll-root abstraction only after Pass 1 is
  validated.
- [ ] Preserve bounded physical window behavior.
- [ ] Preserve native `scrollend + 100ms` rebase policy.
- [ ] Preserve image scheduling, visible image priority, page tracking,
  progress writes, restore, and recommendation tail.
- [ ] Verify reader logs before asking for phone testing.

## Decisions To Move To decisions.md When Done

- Native Safari document scrolling is the target for iOS 27 browser chrome
  behavior.
- Standalone PWA viewport/safe-area behavior is treated as degraded until iOS
  changes; avoid deep PWA-only hacks unless Safari also breaks.
- Scroll migration must happen through an owned root abstraction, not by
  sprinkling document/window special cases through view code.
