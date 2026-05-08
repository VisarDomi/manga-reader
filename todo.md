# TODO

## Reader Performance Follow-Up

- Observed: slow left-to-right swipe jank is visible in logs as repeated `reader-frame-gap`
  entries around 220-294ms while the reader is foreground.
- Fixed in this pass: background search/restore pagination was continuing
  after the reader becomes foreground. Logs show `view-push` to reader followed
  by search `page=10..34` results and repeated `foreground-work visible-prewarm
  defer` events. Reader foreground now cancels restore-owned pagination.
- Fixed in this pass: back-swipe progress no longer writes `$state` on every
  `touchmove`. The gesture action owns a CSS variable during drag and hands back
  to Svelte only at lock/end.
- Started in this pass: `ReaderWindowManager` owns a layout snapshot cache. Its
  key includes ordered chapter ids, viewport width, slot heights/states/page
  counts, and a height revision supplied by the reader height owner.
- Fixed in this pass: page tracking and image scheduling now consume a page
  geometry snapshot owned by `ReaderWindowManager`, instead of reading mounted
  page DOM rectangles during scroll/reconcile work.
- Remaining target: avoid `$state` writes from reader scroll work unless the
  slot set or total virtual height actually changed.
- Remaining target: `Reader.svelte` still has DOM reads for debug close
  snapshots and idle layout measurement/anchor restoration. Those are not in
  the normal scroll hot path, but they should stay clearly labeled as
  measurement/diagnostic ownership.
