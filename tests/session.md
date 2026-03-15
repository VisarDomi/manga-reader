# Session

Tests assert business rules. If a test fails, the code is wrong — not the test.
The only exception is when a business rule changes.

---

### Session Snapshot

**T-AP-1: View transition saves immediately**
Tests rule AP.
Any view change (push or pop) immediately saves viewMode, viewStack, activeProviderKey, activeManga, and searchContext to the session snapshot.

**T-AP-2: Scroll tracking debounced at 1s**
Tests rule AP.
While on list view, the app tracks the center manga card and updates listTargetMangaId (debounced 1s). While on favorites, it updates favoritesTargetMangaId. These are separate fields.

```contract
constant: VISIBLE_MANGA_DEBOUNCE_MS
assert: value === 1_000
```

**T-AP-3: In-session pixel-perfect, cross-session card-level**
Tests rule AP.
Within a session, swiping back from manga to list restores pixel-perfect scroll. Across sessions (cold start), the app paginates to find listTargetMangaId and scrolls to that card.

### Session Restore

**T-AQ-1: Auto-restore on launch if snapshot exists**
Tests rule AQ.
On launch with a session snapshot, the app restores automatically with a "Restoring last position..." toast.

**T-AQ-2: User action cancels restore**
Tests rule AQ.
If the user scrolls, taps a manga, changes view, or starts a search during restore, the restore is cancelled silently.

**T-AQ-3: Restore [list] — replay search + paginate to target**
Tests rule AQ.
Restores search with saved context, paginates until listTargetMangaId is found, scrolls to that card.

**T-AQ-4: Restore [list, repos] — repos shown, search replayed in background**
Tests rule AQ.
Shows repos view immediately. Background: replays search and paginates to target so list has content for swipe-back.

**T-AQ-5: Restore [list, favorites] — favorites shown, search replayed in background**
Tests rule AQ.
Loads favorites from the database, shows favorites view, scrolls to favoritesTargetMangaId. Background: replays search.

**T-AQ-6: Restore [list, manga] — details shown, search replayed in background**
Tests rule AQ.
Fetches chapters for activeManga, restores group selection, shows details. Background: replays search + paginates.

**T-AQ-7: Restore [list, favorites, manga] — details from favorites path**
Tests rule AQ.
Fetches chapters, restores groups, shows details. Background: loads favorites + scrolls to target, replays search + paginates.

**T-AQ-8: Restore [list, manga, reader] — reader foreground, details + list background**
Tests rule AQ.
Reader: loads progress from the database, fetches chapter images, pixel-perfect scroll, loads adjacent chapters.
Details (background): fetches chapters, restores groups, syncs scroll to reader chapter.
List (background): replays search, paginates to target.

**T-AQ-9: Restore [list, favorites, manga, reader] — reader foreground, all else background**
Tests rule AQ.
Same as T-AQ-8 plus favorites loading in background with scroll to favoritesTargetMangaId.

### Reader Position Source of Truth

**T-AR-1: Reader position from database, not session snapshot**
Tests rule AR.
On restore, the reader reads chapter/page position from the database progress store — not the session snapshot. The snapshot only has view mode and active manga.

### Cold Start vs Warm Resume

**T-AU-1: Cold start follows AQ restore sequences**
Tests rule AU.
On cold start (iOS reclaimed memory), the app boots fresh and follows rule AQ restore sequences.

**T-AU-2: Warm resume — surgical recovery, no network**
Tests rule AU.
On warm resume (iOS froze JS): toggle overflow on scroll containers, health-check IntersectionObservers, replace stale abort controllers, restart dead timers.

**T-AU-3: Freeze sentinel detects iOS JS freeze**
Tests rule AU.
A 1-second setInterval checks the clock. If more than 3 seconds pass since the last tick, JS was frozen. This triggers the same recovery as visibilitychange.

**T-AV-1: Cached image data survives warm resume**
Tests rule AV.
When the reader is open during warm resume, images are not re-fetched. Cached image data survives an iOS JS freeze.
