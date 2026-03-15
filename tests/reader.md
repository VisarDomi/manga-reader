# Reader

Tests assert business rules. If a test fails, the code is wrong — not the test.
The only exception is when a business rule changes.

---

### Reading Progress

**T-AH-1: Progress keyed by repoUrl:providerId:mangaId**
Tests rule AH.
Progress stores chapterId, chapterNumber, pageIndex, and scrollOffset, keyed by `repoUrl:providerId:mangaId`.

```contract
class: ReaderState
setup: active provider has repoUrl='https://repo.com' and id='comix'
action: openReader(manga { id: 'one-piece' }, chapter)
assert: db.setProgress called with key 'https://repo.com:comix:one-piece'
assert: key is NOT just 'one-piece' (manga.id alone)
```

**T-AH-2: Only one position per manga per provider**
Tests rule AH.
Opening a different chapter overwrites the previous progress — no per-chapter history.

```contract
class: ReaderState
setup: open manga 'one-piece', chapter A → progress saved
action: open same manga, chapter B → progress saved
assert: progress for 'one-piece' has chapterId === B (not A)
assert: only one entry exists for this manga (no per-chapter history)
```

**T-AI-1: Progress debounced at 3 seconds**
Tests rule AI.
Scroll-based progress updates are debounced at 3s before writing to persistent storage.

```contract
constant: PROGRESS_DEBOUNCE_MS
assert: value === 3_000
```

**T-AJ-1: Current page detected at 1/3 viewport height**
Tests rule AJ.
The visible page is the page element whose top edge is at or above 1/3 of the viewport height from the top.

```contract
constant: VISIBLE_PAGE_RATIO
assert: value === 1/3
```

### Reader Prefetch & Windows

**T-BL-1: Reader image prefetch uses 1500% rootMargin**
Tests rule BL.
The IntersectionObserver for reader page images has `rootMargin: '1500%'`.

```contract
constant: READER_ROOT_MARGIN
assert: value === '1500%'
```

**T-AK-1: Fetch window is ±1 chapters**
Tests rule AK.
Only the current chapter and its immediate neighbors (3 total) have active IntersectionObservers.

**T-AK-2: Cache window is ±2 chapters**
Tests rule AK.
Cached image data is kept for current ±2 chapters (5 total). Cached data is released when a chapter exits this window.

```contract
constant: CACHE_WINDOW
assert: value === 2
note: total cached chapters = current ± CACHE_WINDOW = 5
```

**T-AK-3: Gated observer activation**
Tests rule AK.
When a chapter becomes current, its observer connects immediately. The next-closest chapter's observer connects on the next idle callback after the initial batch. The far chapter connects on the following idle callback.

**T-AK-4: Next-closest based on scroll position**
Tests rule AK.
If the user is in the top half of the current chapter, the previous chapter's observer connects first. If in the bottom half, the next chapter connects first.

**T-AK-5: Jitter protection at chapter boundaries**
Tests rule AK.
Scrolling back and forth between ch 11 and ch 12 never triggers re-fetches — both chapters' cached data stays available.

**T-BM-1: Chapter change at 50% viewport boundary**
Tests rule BM.
Chapter change is detected when a chapter boundary crosses 50% of the viewport. Small scroll jitter at boundaries does not trigger chapter changes.

**T-BM-2: Visual divider between chapters**
Tests rule BM.
A visual divider separates chapters in the reader.

### Image Failure Recovery

**T-BP-1: 404 is permanent — placeholder, no retry**
Tests rule BP.
On a 404, the image shows a placeholder and is not retried. It does not block adjacent chapter loading.

**T-BP-2: Network/timeout errors eligible for retry on reconnect**
Tests rule BP.
On network/timeout failure, the image is marked as failed. On reconnection or warm resume, failed images are re-triggered by resetting the IntersectionObserver.

**T-BP-3: Slow connection toast after 3+ failures in 10s**
Tests rule BP.
If 3 or more image fetches fail within 10 seconds, a one-time "Slow connection — images may not load" toast is shown per session.

### Image Caching

**T-BQ-1: Proxy sets Cache-Control max-age=86400**
Tests rule BQ.
The server's image proxy response includes `Cache-Control: max-age=86400`.

### Details / Reader Sync

**T-BN-1: Details scroll syncs with reader position**
Tests rule BN.
When entering the reader, the details view captures its scroll position. Each chapter change in the reader updates the details scroll target. Swiping back to details scrolls to the chapter the user was last reading.

### Reader Cleanup

**T-BO-1: Swipe animation not interrupted**
Tests rule BO.
During the swipe-back animation, the reader stays visually intact.

**T-BO-2: Progress saved immediately on close**
Tests rule BO.
After the pop animation completes, progress is written to persistent storage immediately (not debounced).

**T-BO-3: In-flight fetches aborted on close**
Tests rule BO.
After pop, all in-flight image fetches are aborted.

**T-BO-4: Cached data released on next idle frame**
Tests rule BO.
Cached image data is released and chapter data cleared on the next idle frame after pop — not during the animation.

### Position Restore

**T-AL-1: Pixel-perfect restore on same chapter reopen**
Tests rule AL.
When reopening a chapter that matches the saved chapterId, the reader scrolls to saved pageIndex + scrollOffset.

**T-AL-2: Image containers pre-sized from dimensions**
Tests rule AL.
Image containers are sized to the correct aspect ratio from the provider's width/height before image bytes load, making scrollOffset valid immediately.

**T-AL-3: Different chapter starts from top**
Tests rule AL.
Opening a chapter different from the saved one starts from the top. The old progress is overwritten.
