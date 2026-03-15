# Test Spec

Tests assert business rules. If a test fails, the code is wrong — not the test.
The only exception is when a business rule changes.

---

## App-Level Tests (packages/app)

### Filters & Search

**T-AA-1: NSFW genres auto-excluded on first install**
Tests rule AA.
Given a provider with `getFilters()` returning genres where some have `nsfw: true`,
when the provider is used for the first time (no saved filters in localStorage for that provider key),
then every genre with `nsfw: true` starts in `exclude` state.

**T-AA-2: NSFW seeding skipped when filters already exist**
Tests rule AA.
Given saved filters already exist in localStorage for the provider key,
when the provider loads,
then no genres are modified — the saved state is used as-is.

**T-AA-3: NSFW seeding is per-provider**
Tests rule AA.
Given provider A has saved filters but provider B does not,
when provider B is activated for the first time,
then provider B's NSFW genres are auto-excluded independently. Provider A's filters are untouched.

**T-AB-1: Genre filter cycles through 3 states**
Tests rule AB.
Given a genre filter chip,
when tapped repeatedly,
then the state cycles: empty → include → exclude → empty.

**T-AB-2: Type and status filters are binary toggles**
Tests rule AB.
Given a type or status filter chip,
when tapped,
then the state toggles: off → on → off.

**T-AB-3: Long-press not used on filter chips**
Tests rule AB.
Filter chips do not respond to long-press. Long-press is reserved for chapter list group items (rule AF).

**T-AC-1: All search inputs share 500ms debounce**
Tests rule AC.
Given any change (keystroke or filter toggle),
when the user stops changing for 500ms,
then a search fires with the current text + current filters combined from page 1, replacing results entirely.

**T-AC-2: Each change restarts the debounce**
Tests rule AC.
Given a keystroke at t=0 and another at t=300ms,
then no search fires at t=500ms. A search fires at t=800ms (500ms after the last change).

**T-AC-3: Changes abort in-flight requests**
Tests rule AC.
Given a search request is in-flight,
when the user makes any change (keystroke or filter toggle),
then the in-flight request is aborted.

**T-AC-4: Enter skips debounce**
Tests rule AC.
Given the user types and immediately presses enter,
then the search fires immediately without waiting 500ms.

**T-AC-5: Search is non-blocking**
Tests rule AC.
While a search is loading,
the UI remains responsive — filters can be toggled, text can be typed.

**T-AC-6: Filters and query persist per provider**
Tests rule AC + BH.
Given the user sets filters and a query,
when the app is reloaded,
then the saved filters and query are restored from localStorage, scoped by provider key.

**T-AD-1: Pagination deduplicates by manga ID**
Tests rule AD.
Given page 1 returns manga [A, B, C] and page 2 returns [C, D, E],
when page 2 appends,
then results are [A, B, C, D, E] — no duplicate C.

**T-AD-2: Pagination stops when hasMore is false**
Tests rule AD.
Given the provider returns `hasMore: false`,
then no further pages are requested.

**T-AE-1: Infinite scroll sentinel uses 500% rootMargin**
Tests rule AE.
The IntersectionObserver for the list sentinel has `rootMargin: '500% 0px'`.

### Manga Cards

**T-AS-1: Manga cards show cover only**
Tests rule AS.
Manga cards render only the cover image — no title text, no author, no badges, no padding between cards.

**T-AS-2: Progress bar shown only for manga with saved progress**
Tests rule AS.
Given manga A has saved progress and manga B does not,
then manga A's card shows a reading progress bar at the bottom. Manga B's card shows no overlay.

### Chapter Groups

**T-AF-1: Provider-wide group blacklist hides chapters**
Tests rule AF.
Given group X is in the provider-wide blacklist,
then chapters from group X are hidden across all manga for that provider.

**T-AF-2: Per-manga group selector overrides blacklist**
Tests rule AF.
Given group X is blacklisted provider-wide but selected in the per-manga selector,
then group X's chapters are visible for that manga only.

**T-AF-3: Blacklisted groups appear grayed out but selectable**
Tests rule AF.
In the per-manga group selector, provider-wide blacklisted groups are visually grayed out but can still be selected.

**T-AF-4: Same chapter number from multiple groups — latest upload wins**
Tests rule AF.
Given group A uploaded chapter 5 on Jan 1 and group B uploaded chapter 5 on Jan 2, and both groups are selected,
then only group B's chapter 5 is shown.

**T-AF-5: Chapters sorted descending by number**
Tests rule AF.
Chapters are displayed newest first (descending by chapter number).

**T-AF-6: Long-press on group item shows block/cancel**
Tests rule AB + AF.
Long-pressing a group item in the chapter list shows a block/cancel option to add the group to the provider-wide blacklist.

### Progressive Chapter Loading

**T-AG-1: Chapters yielded progressively in descending order**
Tests rule AG.
When opening a manga, the app renders chapters as each page arrives without waiting for the full list. Page 1 (newest chapters) fills the top of the list.

**T-AG-2: Deduplication on each batch**
Tests rule AG.
On each incoming batch, the app deduplicates by chapter ID and re-applies group filtering and sorting.

**T-AG-3: Partial data shown on partial failure**
Tests rule AG.
If some chapter list pages fail but others succeed, the app shows what it got.

### Reading Progress

**T-AH-1: Progress keyed by repoUrl:providerId:mangaId**
Tests rule AH.
Progress stores chapterId, chapterNumber, pageIndex, and scrollOffset, keyed by `repoUrl:providerId:mangaId`.

**T-AH-2: Only one position per manga per provider**
Tests rule AH.
Opening a different chapter overwrites the previous progress — no per-chapter history.

**T-AI-1: Progress debounced at 3 seconds**
Tests rule AI.
Scroll-based progress updates are debounced at 3s before writing to IndexedDB.

**T-AJ-1: Current page detected at 1/3 viewport height**
Tests rule AJ.
The visible page is the page element whose top edge is at or above 1/3 of the viewport height from the top.

### Reader Prefetch & Windows

**T-BL-1: Reader image prefetch uses 1500% rootMargin**
Tests rule BL.
The IntersectionObserver for reader page images has `rootMargin: '1500%'`.

**T-AK-1: Fetch window is ±1 chapters**
Tests rule AK.
Only the current chapter and its immediate neighbors (3 total) have active IntersectionObservers.

**T-AK-2: Cache window is ±2 chapters**
Tests rule AK.
Blob URLs are kept for current ±2 chapters (5 total). Blobs are revoked when a chapter exits this window.

**T-AK-3: Gated observer activation**
Tests rule AK.
When a chapter becomes current, its observer connects immediately. The next-closest chapter's observer connects on the next idle callback after the initial batch. The far chapter connects on the following idle callback.

**T-AK-4: Next-closest based on scroll position**
Tests rule AK.
If the user is in the top half of the current chapter, the previous chapter's observer connects first. If in the bottom half, the next chapter connects first.

**T-AK-5: Jitter protection at chapter boundaries**
Tests rule AK.
Scrolling back and forth between ch 11 and ch 12 never triggers re-fetches — both chapters' blobs stay cached.

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
On network/timeout failure, the image is marked as failed. On `online` event or warm resume, failed images are re-triggered by resetting the IntersectionObserver.

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
After the pop animation completes, progress is written to IDB immediately (not debounced).

**T-BO-3: In-flight fetches aborted on close**
Tests rule BO.
After pop, all in-flight image fetches are aborted.

**T-BO-4: Blobs revoked on next idle frame**
Tests rule BO.
Blob URLs are revoked and chapter data cleared on the next idle frame after pop — not during the animation.

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

### Favorites

**T-AM-1: Optimistic toggle with revert on failure**
Tests rule AM.
Toggling a favorite updates the UI immediately. If the IDB write fails, the UI reverts and a toast is shown.

**T-BR-1: Favorites ordered by insertion order**
Tests rule BR.
Favorites appear oldest first, newest at bottom.

**T-BR-2: Favorites scroll target is middle-of-viewport card**
Tests rule BR.
For session restore, the scroll target is whichever manga card was at the middle of the viewport when the user left favorites.

### IDB Error Handling

**T-AN-1: Read failures resolve with empty data + one-time toast**
Tests rule AN.
IDB read failures (progress lookups, favorites listing) resolve with empty data. A one-time toast per session notifies the user.

**T-AN-2: Write failures reject for caller handling**
Tests rule AN.
IDB write failures reject. Favorites reverts the optimistic update (AM). Progress shows a toast on first failure per session.

**T-AN-3: DB init failure shows error state without crash**
Tests rule AN.
If IDB initialization fails, a "Storage unavailable" toast is shown. The app remains usable for browsing and reading without persistence.

### View Stack

**T-AO-1: Exactly 7 valid view stack configurations**
Tests rule AO.
The view stack only allows these configurations:
- `[list]`
- `[list, repos]`
- `[list, favorites]`
- `[list, manga]`
- `[list, favorites, manga]`
- `[list, manga, reader]`
- `[list, favorites, manga, reader]`

**T-AO-2: Back always pops one level**
Tests rule AO.
Back (swipe or button) pops one level from the stack. No skipping, no duplicates.

**T-AO-3: Repos is a leaf**
Tests rule AO.
From repos, you can only go back to list — not deeper.

**T-AO-4: Session restore rebuilds all views below current**
Tests rule AO.
On restore, every view below the current one has correct content so swipe-back reveals the right screen.

### Session Snapshot

**T-AP-1: View transition saves immediately**
Tests rule AP.
Any view change (push or pop) immediately saves viewMode, viewStack, activeProviderKey, activeManga, and searchContext to the session snapshot.

**T-AP-2: Scroll tracking debounced at 1s**
Tests rule AP.
While on list view, the app tracks the center manga card and updates listTargetMangaId (debounced 1s). While on favorites, it updates favoritesTargetMangaId. These are separate fields.

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
Loads favorites from IDB, shows favorites view, scrolls to favoritesTargetMangaId. Background: replays search.

**T-AQ-6: Restore [list, manga] — details shown, search replayed in background**
Tests rule AQ.
Fetches chapters for activeManga, restores group selection, shows details. Background: replays search + paginates.

**T-AQ-7: Restore [list, favorites, manga] — details from favorites path**
Tests rule AQ.
Fetches chapters, restores groups, shows details. Background: loads favorites + scrolls to target, replays search + paginates.

**T-AQ-8: Restore [list, manga, reader] — reader foreground, details + list background**
Tests rule AQ.
Reader: loads progress from IDB → fetches chapter images → pixel-perfect scroll → loads adjacent chapters.
Details (background): fetches chapters, restores groups, syncs scroll to reader chapter.
List (background): replays search, paginates to target.

**T-AQ-9: Restore [list, favorites, manga, reader] — reader foreground, all else background**
Tests rule AQ.
Same as T-AQ-8 plus favorites loading in background with scroll to favoritesTargetMangaId.

### Reader Position Source of Truth

**T-AR-1: Reader position from IDB, not session snapshot**
Tests rule AR.
On restore, the reader reads chapter/page position from IDB progress — not the session snapshot. The snapshot only has view mode and active manga.

### Swipe-Back Gesture

**T-AT-1: Edge zone is left 7.7% of screen width**
Tests rule AT.
The swipe must start within the left 7.7% of the screen.

**T-AT-2: 1.3% deadzone before lock**
Tests rule AT.
A 1.3% deadzone must be crossed before the gesture locks. If vertical movement exceeds horizontal before the deadzone, the gesture is rejected.

**T-AT-3: 15% drag threshold to trigger back**
Tests rule AT.
After locking, the user must drag at least 15% of the remaining screen width to trigger navigation.

**T-AT-4: Animation follows drag and snaps**
Tests rule AT.
The view animates with the drag position and snaps to completion or cancellation on release.

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

**T-AV-1: Blob URLs survive warm resume**
Tests rule AV.
When the reader is open during warm resume, images are not re-fetched. Blob URLs survive an iOS JS freeze.

### Cloudflare

**T-AW-1: Cloudflare gate drops new app-level requests**
Tests rule AW.
While Cloudflare solving is in progress, new user-initiated searches, manga opens, and chapter opens are dropped — not queued.

**T-AW-2: Provider in-flight operations can wait and retry**
Tests rule AW.
The provider's own in-flight operations (e.g. parallel chapter list fetches) wait for solving to complete and retry.

**T-AW-3: Callers retry if still relevant after solve**
Tests rule AW.
After solving completes: search fires with current query+filters, manga view re-fetches if still mounted, reader's observer re-fires for visible images. If caller navigated away, nothing retries.

**T-AW-4: Toast only on foreground block**
Tests rule AW.
Cloudflare solving is silent unless the user's foreground action is blocked.

### Loading Watchdog

**T-AX-1: Watchdog resets after 15 seconds**
Tests rule AX.
If `isLoading` stays true for 15+ seconds, the watchdog force-resets to idle, logs `console.error`, and shows "Something went wrong — pull down to refresh."

### Pagination Errors

**T-AY-1: Transient errors roll back page and allow retry**
Tests rule AY.
On transient errors (408, 429, 500, 502, 503, 504, network, timeout): page counter rolls back, hasMore stays true, toast shows "Slow connection, scroll to retry."

**T-AY-2: Permanent errors stop pagination**
Tests rule AY.
On permanent errors (400, 403, 404, etc.): hasMore set to false, pagination stops, toast shows "Failed to load more results."

**T-AY-3: All errors logged with full context**
Tests rule AY.
Errors are logged with URL, status, response body snippet, and timestamp.

### Error Types

**T-AZ-1: Errors are a tagged union of 4 kinds**
Tests rule AZ.
All errors are: `upstream` (HTTP, carries status), `timeout`, `network` (TypeError), or `cloudflare` (503 + Cloudflare header). UI pattern-matches on `kind`.

### Dynamic Timeout

**T-BA-1: Timeout is 3x rolling average of last 100 responses**
Tests rule BA.
The timeout per provider is 3× the rolling average of the last 100 response times, persisted in IDB.

**T-BA-2: First-use default is 10 seconds**
Tests rule BA.
On first use of a provider (no samples), the timeout is 10 seconds.

**T-BA-3: Each provider has independent timeout profile**
Tests rule BA.
Switching providers loads that provider's response history. Profiles don't cross-pollinate.

**T-BA-4: Server proxy has no product-level timeout**
Tests rule BA.
The server proxy defers to the app's dynamic timeout — it does not enforce its own timeout on proxied requests.

### Error Display

**T-BB-1: Initial failure shows persistent error with retry**
Tests rule BB.
When the initial search or manga open fails, the app shows a persistent error state with error kind and "Tap to retry". No disappearing toast for an empty screen.

**T-BB-2: Pagination failure shows toast**
Tests rule BB.
When pagination fails (results already on screen), a transient toast is shown.

### Chapter Image Retry

**T-BC-1: Transient errors retry once after 1 second**
Tests rule BC.
On transient image fetch errors (408, 429, 5xx, network, timeout), one automatic retry after 1s delay. If retry fails, persistent error state with retry.

### Provider Boot Failures

**T-BD-1: First search failure shows persistent error**
Tests rule BD.
If the first search on cold start fails (no cache, no session), persistent error state with error kind and "Tap to retry".

**T-BD-2: Corrupted provider bundle shows "Provider unavailable"**
Tests rule BD.
If loading the provider's JS bundle from IDB fails, "Provider unavailable" with retry.

**T-BD-3: No provider installed shows empty state**
Tests rule BD + BF.
If no provider is installed, show empty state with prompt to add a provider.

### IDB Storage Bounds

**T-BE-1: Progress is one entry per manga**
Tests rule BE.
Progress store has one entry per `repoUrl:providerId:mangaId` (~50 bytes each).

**T-BE-2: Response times are fixed window of 100**
Tests rule BE.
Response times per provider are capped at 100 samples.

**T-BE-3: No images or large blobs in IDB**
Tests rule BE.
The reader uses in-memory blob URLs — no images stored in IDB.

### First Launch

**T-BF-1: Empty state with "Add a provider" button**
Tests rule BF.
On first launch with no provider, list view shows "Add a provider to get started" with a button that pushes repos view. Search, filters, and provider-dependent features are disabled.

### Repository & Provider Management

**T-BG-1: Multiple repos listed together**
Tests rule BG.
Multiple repos can be added and all their providers are listed together.

**T-BG-2: Provider identity scoped by repo**
Tests rule BG.
A provider's unique key is `repoUrl:providerId`. Same ID from different repos are separate providers.

**T-BG-3: Install makes provider active and fires search**
Tests rule BG.
Installing a provider makes it active and fires an empty-query search. Swiping back reveals results.

**T-BG-4: Uninstall confirmation and cleanup**
Tests rule BG.
Uninstalling shows confirmation. On confirm, removes JS bundle and all associated data (progress, favorites, filters, group blacklist, response times). Falls back to another provider or empty state.

**T-BG-5: Tap installed provider switches to it**
Tests rule BG.
Tapping an installed provider (not the - button) switches to it and reloads the list view with that provider's context.

**T-BG-6: Auto-update on cold start and repos view entry**
Tests rule BG.
The app checks for newer provider versions on cold start (background) and when entering repos view. Updated bundles download silently and take effect on next provider load. Badge shown on success, toast on failure.

### Data Isolation

**T-BH-1: All data scoped by repoUrl:providerId**
Tests rule BH.
IDB progress, IDB favorites, localStorage filters, localStorage group blacklist, IDB response times, and session snapshot activeProviderKey are all scoped by provider key.

**T-BH-2: Switching providers loads that provider's data**
Tests rule BH.
Switching providers loads the target provider's data context. The previous provider's data is untouched.

### Provider Loading

**T-BI-1: Loads activeProviderKey from session snapshot**
Tests rule BI.
On cold start, reads activeProviderKey from session snapshot and loads that provider's bundle from IDB.

**T-BI-2: Falls back to first installed provider**
Tests rule BI.
If no activeProviderKey but providers are installed, activates the first installed provider.

### Server Proxy

**T-BJ-1: Proxy is provider-agnostic**
Tests rule BJ.
The server proxy forwards requests to whatever domain the provider specifies. No hardcoded upstream domains.

**T-BJ-2: Cloudflare cookies keyed by domain**
Tests rule BJ.
Two providers on the same domain share Cloudflare cookies. Two providers on different domains solve independently.

### TLS CA Distribution

**T-BK-1: Server exposes mkcert root CA at well-known endpoint**
Tests rule BK.
The server serves the CA as a downloadable PEM file for iOS devices to install and trust.

---

## Provider-Level Tests (packages/extensions — comix)

### Search Page Size

**T-C1-1: Search limit is 100**
Tests comix rule 1.
The search request uses `limit=100`.

**T-C1-2: Chapter list limit is 100**
Tests comix rule 1.
The chapter list request uses `limit=100`.

### hasMore Computation

**T-C2-1: hasMore = current_page < last_page**
Tests comix rule 2.
Given a pagination object with `current_page` and `last_page`, `hasMore` is `current_page < last_page`.

**T-C2-2: No extra request when total is multiple of 100**
Tests comix rule 2.
Given `current_page == last_page`, `hasMore` is false — no trailing empty request.

### Sort Order

**T-C3-1: No keyword — sort by chapter_updated_at desc**
Tests comix rule 3.
When query is empty or only filters are applied, the request includes sort by `chapter_updated_at` descending.

**T-C3-2: With keyword — no explicit sort**
Tests comix rule 3.
When the user types a keyword, no sort parameter is sent (API default relevance ranking).

### NSFW Genres

**T-C4-1: Exactly 5 NSFW genres**
Tests comix rule 4.
`getFilters()` marks exactly these 5 genres as `nsfw: true`: Adult, Ecchi, Hentai, Mature, Smut.

**T-C4-2: NSFW flag is on genre options**
Tests comix rule 4.
Each of the 5 NSFW genres has `nsfw: true` in the FilterDefinition returned by `getFilters()`.

### Adaptive Chapter Pagination

**T-C5-1: Page 1 fetched first and yielded immediately**
Tests comix rule 5.
The first request is page 1 with `limit=100, order[number]=desc`. Its results are yielded immediately before remaining pages are fetched.

**T-C5-2: Remaining pages fetched in parallel**
Tests comix rule 5.
After page 1 returns, the provider reads `last_page` and fetches all remaining pages in parallel, yielding each as it arrives.

**T-C5-3: No artificial cap on pages**
Tests comix rule 5.
A manga with 800 chapters produces 8 requests. A manga with 9 chapters produces 1.

**T-C5-4: Cloudflare during chapter fetch — yield partial, wait, retry**
Tests comix rule 5 + 6.
If a parallel request hits Cloudflare: yield results from succeeded requests, trigger solving, wait for "solved" SSE, retry failed requests with cached cookies.

### Cloudflare Strategy

**T-C6-1: SSE connection to solving-status endpoint**
Tests comix rule 6.
On Cloudflare block, the client opens an SSE connection to the solving-status endpoint and waits.

**T-C6-2: "solved" event triggers retry**
Tests comix rule 6.
On receiving "solved", the client closes SSE and retries the original request.

**T-C6-3: "failed" event propagates error**
Tests comix rule 6.
On receiving "failed", the SSE closes and the error propagates to the caller.

**T-C6-4: No polling, no fixed intervals**
Tests comix rule 6.
The client uses SSE push notifications — no polling, no arbitrary retry counts.

### Chapter Image Extraction

**T-C7-1: Extracts images from escaped format**
Tests comix rule 7.
Given HTML with `\"images\":[{\"url\":\"https:\/\/cdn.com\/page1.jpg\"}]`, the parser extracts the image list correctly.

**T-C7-2: Extracts images from unescaped format**
Tests comix rule 7.
Given HTML with `"images":[{"url":"https://cdn.com/page1.jpg"}]`, the parser extracts the image list correctly.

**T-C7-3: Tries escaped first, falls back to unescaped**
Tests comix rule 7.
The parser attempts the escaped pattern first. If no match, it tries unescaped. If neither matches, it throws.

**T-C7-4: Validates extracted JSON with JSON.parse**
Tests comix rule 7.
After extraction and unescaping, the result is validated through `JSON.parse`.

### Image Referer Header

**T-C8-1: imageHeaders returns Referer: https://comix.to**
Tests comix rule 8.
`imageHeaders()` returns `{ Referer: 'https://comix.to' }`.

### Manga ID

**T-C9-1: Uses hash_id as primary ID**
Tests comix rule 9.
Given a manga with `hash_id: "okdv"`, the provider uses `"okdv"` as the manga ID.

**T-C9-2: Falls back to slug if hash_id missing**
Tests comix rule 9.
Given a manga without `hash_id` but with `slug: "one-piece"`, the provider uses `"one-piece"` as the manga ID.
