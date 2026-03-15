# Business Decisions

These are product decisions that drive the app's behavior. Tests are derived from these rules.
A test only changes if a business decision changes.

## AA. NSFW Genres Auto-Excluded on First Install

When a provider is used for the first time (no prior filter state in localStorage for that provider), the app auto-excludes all genres that the provider marks as NSFW. The app does not know which genres are NSFW by name — it asks the provider via `getFilters()` and excludes every genre flagged `nsfw: true`. After this one-time seeding, the user can toggle any of them freely. If the provider already has saved filters, this seeding is skipped entirely. This triggers independently per provider — installing a second provider seeds its NSFW genres even if the first provider's filters already exist.

## AB. Genre Filters Are 3-State Toggles

Each genre filter cycles through three states on tap: empty (no filter) → include → exclude → back to empty. This applies to all genre terms, including the NSFW ones seeded in rule AA. Types and statuses are simpler binary toggles (on/off). Long-press is not used on filter chips — it is reserved for the chapter list's group items, where it shows a block/cancel option to add the group to the provider-wide blacklist (see AF).

## AC. Filter and Search Interaction

All search inputs — filter toggles (genre, type, status) and text input — go through the same 500ms debounce. Every change (keystroke, filter toggle) restarts the debounce and aborts any in-flight search request. After 500ms of no changes, a new search fires from page 1 with the current text + current filters combined, replacing the entire result set. Any in-flight pagination (rule AD) is implicitly abandoned because the results are replaced. Pressing enter skips the debounce and fires immediately.

The fetch is always non-blocking — the UI stays responsive while results load. The user can freely mix toggling filters and typing without the UI freezing or results resetting mid-edit. Filters and query persist to localStorage, scoped per provider (see BH).

## AD. Search Pagination with Deduplication

Search results are paginated from the upstream provider. Each page append deduplicates by manga ID to prevent duplicates across pages. The app relies on the provider's `hasMore` flag to know when to stop — it never hardcodes a page size threshold itself. The provider returns `hasMore` with each page of results; the app uses it as-is.

## AE. Infinite Scroll Trigger Zone

The infinite scroll sentinel fires 5 viewports before the user reaches the bottom of the list (rootMargin: 500% 0px). This aggressive prefetch means the user almost never sees a loading state during normal scrolling — new pages load well before they're visible.

## AS. Manga Cards Are Cover-Only

Manga cards show the cover image and nothing else — no title, no author, no badges, no padding between cards. The only overlay is a reading progress bar at the bottom of the card, visible only for manga with saved progress. This is a deliberate deviation from standard manga apps (Tachiyomi, MangaDex) which show title text and metadata below each card. The tradeoff: less information per card, but more covers visible at once and faster visual scanning. The user identifies manga by cover art, not by reading titles.

## AF. Chapter Group Filtering

Chapter filtering is a single pipeline: raw chapters in, filtered/deduped/sorted chapters out. The pipeline takes three inputs — the raw chapter list, the provider-wide blacklist, and the per-manga group selection — and produces one output. The stages are:

1. **Blacklist filter:** Remove chapters whose group is in the provider-wide blacklist (hide this scanlation group's chapters across all manga for the active provider — see BH). In the per-manga group selector, blacklisted groups appear grayed out but remain selectable.
2. **Per-manga group selection:** If the user has selected specific groups for this manga, keep only chapters from those groups. Selecting a blacklisted group overrides the blacklist for that manga only.
3. **Dedup by chapter number:** When multiple groups have the same chapter number, the latest upload wins.
4. **Sort descending:** Chapters are sorted by number, newest first.

These stages are not separate functions — the pipeline is one unit. Tests assert the pipeline's end state for each behavior.

## AG. Chapters Are Yielded Progressively

When opening a manga, the provider yields chapters in descending order (newest first) as soon as each page arrives — the app renders them immediately without waiting for the full list. The app expects descending order so that page 1 fills the top of the chapter list (what the user sees) and subsequent pages append below without causing scroll jumps. The provider handles the pagination strategy (how many requests, what page size, parallel or sequential). The app owns deduplication: it deduplicates by chapter ID on each batch and re-applies group filtering and sorting on each update. If some pages fail but others succeed, the app shows what it got — partial data is better than nothing.

## AH. Progress Is Tracked Per Manga

Reading progress stores chapterId, chapterNumber, pageIndex, and scrollOffset (pixel offset within the current page), keyed by `repoUrl:providerId:mangaId` (see BH). This means progress remembers which chapter you were on, which page, and exactly where on that page — but only the latest position per manga per provider, not per chapter.

## AI. Progress Synced with 3s Debounce

Scroll-based progress updates are debounced at 3s before writing to IndexedDB. This prevents thrashing the database during continuous scrolling while still capturing position reliably when the user pauses or leaves.

## AJ. Current Page Detected at 1/3 Down the Viewport

The visible page is determined by which page element sits at 1/3 of the viewport height from the top — not the center, not the top edge. This accounts for the natural reading position where your eyes focus below the top of the screen.

## BL. Reader Image Prefetch Margin

Individual page images in the reader are lazy-loaded via IntersectionObserver with a 1500% rootMargin — images start loading 15 viewports before they become visible. This is separate from the infinite scroll sentinel on the list view (rule AE, 500%). A typical chapter is 100+ viewports tall, so 1500% prefetches roughly 15% ahead within the current chapter without reaching into adjacent chapters.

## AK. Reader Has Two Chapter Windows: Fetch (±1) and Cache (±2)

The reader uses two windows around the current chapter:

- **Fetch window (±1):** The current chapter plus its immediate neighbors (3 chapters) are eligible for image loading. Each chapter in the fetch window owns its own IntersectionObserver (with the rootMargin from BL). Priority is enforced by gated activation: only the current chapter's observer is connected initially. When the observer is first connected, it synchronously fires for all elements already intersecting the root margin — this is the initial batch. On the next idle callback after the initial batch, the next-closest chapter's observer is connected, then the far one on the following idle callback. "Next-closest" is based on scroll position — if the user is in the top half of the chapter, the previous chapter connects first; if in the bottom half, the next chapter connects first. When a chapter leaves the fetch window, its observer is disconnected. When a new chapter becomes current, its observer is connected immediately and the gating sequence restarts.
- **Cache window (±2):** Blob URLs are kept in memory for 5 chapters (current ±2). Chapters that leave the fetch window but are still in the cache window keep their blobs — images are already loaded, just not actively fetching new ones. Blob URLs are only revoked when a chapter exits the cache window.

This gives jitter protection at chapter boundaries. Scrolling back and forth between ch 11 and ch 12 never triggers re-fetches — both chapters' blobs stay cached. Only when you reach ch 14 does ch 11's blobs get revoked.

## BM. Chapter Loading Priority and Boundaries

When opening a chapter, observer activation follows the gating sequence defined in AK — current chapter's observer connects first, adjacent chapters connect after the initial batch fires and the idle callback runs. No counting or tracking is needed — the gate is purely timing-based (synchronous observer fire → idle callback). This applies to both fresh opens from details and restores that land mid-chapter. Chapter change is detected when a chapter boundary crosses 50% of the viewport — this is position-based, not time-based, so small scroll jitter at boundaries doesn't trigger chapter changes. A visual divider separates chapters in the reader.

## BP. Image Fetch Failure Recovery

Image fetch failures are handled differently based on the error:

- **404 (permanent):** The image is treated as done — show a placeholder, do not retry. It does not block adjacent chapter loading.
- **Network/timeout (recoverable):** The image is marked as failed but eligible for retry. On internet reconnection (via `online` event) or warm resume, the app re-triggers all failed images by resetting the IntersectionObserver so it re-fires for visible elements.
- **Slow connection detection:** If 3+ image fetches fail within 10 seconds, show a one-time "Slow connection — images may not load" toast per session.

## BQ. Image Proxy Responses Are HTTP-Cached for 24 Hours

The server's image proxy sets `Cache-Control: max-age=86400` on every proxied image response. This works as a complement to BO: when the reader closes, blob URLs are revoked and memory is freed — but the browser's HTTP disk cache retains the image bytes for 24 hours. If the user reopens the same chapter, new blob URLs are created but the underlying `fetch()` calls hit the disk cache instead of round-tripping through the server to the CDN. This gives the memory benefits of blob revocation (BO) without the network cost of re-fetching on reopen.

## BN. Details List Syncs with Reader Position

When entering the reader, the details view captures its current scroll position (as a viewport ratio). While reading, every chapter change updates the details view's scroll target to the new chapter. When swiping back to details, the chapter list scrolls to show the chapter you were last reading — not the one you originally opened from.

## BO. Reader Cleanup on Close

When the user swipes back from the reader, cleanup happens in a specific order to avoid visual glitches:

1. **During swipe animation:** nothing happens — the reader stays visually intact while sliding away.
2. **Animation completes:** pop the view stack (details becomes active).
3. **Immediately after pop:** write progress to IDB immediately instead of waiting for the 3s debounce — save the exact position now. Abort all in-flight image fetches.
4. **Deferred (next idle frame):** revoke all blob URLs, clear loaded chapter data, destroy the page tracker.

This ensures the reader never shows blank images during the swipe animation, progress is never lost, and memory is freed when the user isn't looking.

## AL. Pixel-Perfect Position Restored on Chapter Reopen

When reopening a chapter that has saved progress (same chapterId as the stored progress), the reader scrolls to the saved pageIndex and then applies the saved scrollOffset to restore the exact pixel position within that page. This works because the provider is required to return image dimensions (width, height) with each `ChapterPage` — the app sizes image containers to the correct aspect ratio before the actual image bytes load, so scrollOffset is valid immediately. If opening a different chapter than what's saved, the reader starts from the top and the old progress is overwritten — only one position is ever stored per manga (see AH).

## AM. Favorites Toggle Is Optimistic with Revert

Toggling a favorite updates the UI immediately before the IDB write completes. If the write fails, the UI reverts to the previous state and shows a toast. This gives instant feedback without waiting for the database.

## BR. Favorites Are Ordered by Insertion Order

Favorites appear in the order they were added (oldest first, newest at bottom). For session restore, the scroll target is whichever manga card was at the middle of the viewport when the user left the favorites view.

## AN. IDB Error Handling

IDB operations follow these rules:

- **Reads** (progress lookups, favorites listing): resolve with empty data so the app can still function, but show a one-time toast per session so the user knows their data didn't load.
- **Writes** (saving progress, adding/removing favorites): reject on failure so callers can handle it. Callers decide how to handle the rejection — favorites reverts the optimistic update (rule AM), progress shows a toast on first failure per session.
- **Database initialization failure**: show a clear error state (e.g. "Storage unavailable" toast), do not crash the app. The app should remain usable for browsing and reading — just without persistence.

## AO. View Stack Has Exactly 7 Valid Configurations

The view stack is fixed — no skipping levels, no duplicates, max depth 4. The valid stacks are:

- `[list]` — browsing search results
- `[list, repos]` — managing repos and providers (list is behind)
- `[list, favorites]` — viewing favorites (list is behind)
- `[list, manga]` — viewing details from search (list is behind)
- `[list, favorites, manga]` — viewing details from favorites (favorites and list are behind)
- `[list, manga, reader]` — reading from search path (details and list are behind)
- `[list, favorites, manga, reader]` — reading from favorites path (details, favorites, and list are behind)

Back (swipe or button) always pops one level. The repos view is a leaf — you can only go back to list from it, not deeper. On session restore, every view below the current one is also restored with correct content so swipe-back reveals the right screen.

## AP. Session Snapshot Has Two Save Triggers

The session snapshot is a single object in localStorage with these fields: viewMode, viewStack, activeProviderKey, activeManga, listTargetMangaId, favoritesTargetMangaId, and searchContext. Two triggers update different parts of it:

- **View transition** (immediate): any view change (push or pop) saves viewMode, viewStack, activeProviderKey, activeManga, and searchContext immediately.
- **Scroll tracking** (debounced 1s): while on the list view, the app tracks which manga card is at the center of the viewport and updates listTargetMangaId. While on the favorites view, it updates favoritesTargetMangaId. These are separate fields because list and favorites contain different manga — a scroll target from one view may not exist in the other.

Both triggers write to the same snapshot. View transitions capture *what view you're on*, scroll tracking captures *where you were looking* in each scrollable view.

Scroll position has two layers: within a session, the app caches the exact pixel scroll position of the list view in memory — when swiping back from manga details to the list, it restores pixel-perfect. Across sessions, only `listTargetMangaId` (a card ID) is persisted — on cold start, the app paginates to find that card and scrolls to it (card-level precision, not pixel-perfect). The same applies to `favoritesTargetMangaId` for the favorites view.

## AQ. Session Restore Is Automatic and Abortable

On app launch, if a session snapshot exists, the app restores it automatically. While restoring, a passive "Restoring last position..." toast is shown. If the user takes any action during restore (scrolls, taps a manga, changes view, or starts a new search), the restore is cancelled silently — user action always wins. Each phase is independently abortable.

All restore sequences require the active provider to be loaded first (see BI). Each stack configuration (see AO) has its own restore sequence:

**`[list]` — restore list view:**
- Read session snapshot → get searchContext (query + filters) and listTargetMangaId (last visible card)
- Replay search with saved context
- Paginate until listTargetMangaId found in results
- Auto-scroll to that card

**`[list, repos]` — restore repos view:**
- Read session snapshot → get searchContext, listTargetMangaId
- Show repos view with current repo list and installed providers from IDB
- In background: replay search with saved context, paginate to listTargetMangaId (so list behind has content for swipe-back)

**`[list, favorites]` — restore favorites view:**
- Read session snapshot → get searchContext and favoritesTargetMangaId
- Load favorites from IDB
- Show favorites view, scroll to favoritesTargetMangaId
- In background: replay search with saved context (so list behind favorites has content for swipe-back)

**`[list, manga]` — restore details from search:**
- Read session snapshot → get activeManga, searchContext, listTargetMangaId
- Fetch chapter list for activeManga (progressive yield, descending)
- Restore group selection from localStorage
- Show details view
- In background: replay search + paginate to listTargetMangaId (so list behind has content for swipe-back)

**`[list, favorites, manga]` — restore details from favorites:**
- Read session snapshot → get activeManga, searchContext, favoritesTargetMangaId, listTargetMangaId
- Fetch chapter list for activeManga (progressive yield, descending)
- Restore group selection from localStorage
- Show details view
- In background: load favorites from IDB, scroll to favoritesTargetMangaId. Replay search with saved context, paginate to listTargetMangaId (so both views behind have content for swipe-back)

**`[list, manga, reader]` — restore reader from search (bottom-up, parallel):**

Three layers restore independently and in parallel — the reader shows immediately once its chapter loads, the views behind it restore in the background:

- **Reader (foreground, highest priority):** Read IDB progress → get chapterId, pageIndex, scrollOffset. Fetch chapter images for the saved chapterId. Scroll to saved pageIndex + pixel offset. Show reader view immediately. Then load adjacent chapters per BM.
- **Details (background):** Fetch chapter list for activeManga using progressive yield (AG). Restore group selection from localStorage. Scroll details list to the chapter the reader is on. If the reader moves to a different chapter during restore, details syncs per BN.
- **List (background):** Replay search with saved searchContext. Paginate to listTargetMangaId. Restore scroll position.

**`[list, favorites, manga, reader]` — restore reader from favorites (bottom-up, parallel):**

Four layers restore independently and in parallel — the reader shows immediately, everything else restores in the background:

- **Reader (foreground, highest priority):** Same as above — IDB progress → fetch chapter images → pixel-perfect scroll → load adjacent chapters.
- **Details (background):** Same as above — fetch chapters, restore group selection, sync scroll to reader's chapter.
- **Favorites (background):** Load favorites from IDB. Scroll to favoritesTargetMangaId.
- **List (background):** Replay search with saved searchContext. Paginate to listTargetMangaId. Restore scroll position.

## AR. IDB Progress Is the Source of Truth for Reader Position

When restoring a reader session, the app reads the reader position from IDB progress — not from the session snapshot. The session snapshot only records view mode and active manga. The actual chapter and page position always come from IDB, which is updated more frequently (3s debounce vs only on view transition for the snapshot).

## AT. Swipe-Back Gesture

Navigation back (from reader → manga, manga → list, etc.) is triggered by a left-edge swipe gesture. The swipe must start within the left 7.7% of the screen width (edge zone). A 1.3% deadzone must be crossed before the gesture locks — if vertical movement exceeds horizontal before the deadzone is crossed, the gesture is rejected as a vertical scroll. Once locked, the user must drag at least 15% of the remaining screen width to trigger the back navigation. The view animates with the drag and snaps to completion or cancellation on release.

## AU. Cold Start vs Warm Resume

iOS can background the PWA in two ways, and the app handles each differently:

**Cold start (iOS reclaimed memory, PWA starts fresh):** The app boots from scratch — all JS is new, all observers are fresh, no stale state. This is purely a data restoration problem. The app follows the restore sequences defined in AQ.

**Warm resume (iOS froze JS but kept memory):** All state is intact — search results, blob URLs, reader position. But browser internals may be broken. Recovery is surgical, no network requests:
- Toggle overflow on scroll containers (fixes WebKit touch handler desync)
- Health-check IntersectionObservers — if the sentinel is in viewport but didn't fire, reconnect it
- Replace stale abort controllers
- Restart any dead timers (progress debounce, etc.)

**Detection:** Cold start is detected by the app initializing from scratch (no prior in-memory state). Warm resume is detected by two mechanisms that both trigger the same recovery:

- **`visibilitychange` event:** The browser fires this when the user switches back to the app. Works reliably on desktop, inconsistently on iOS PWA.
- **Freeze sentinel (iOS workaround):** A 1-second `setInterval` that checks the clock on each tick. If more than 3 seconds have passed since the last tick, JS was frozen by iOS. This catches cases where `visibilitychange` doesn't fire — which happens regularly in iOS PWA when unfreezing from a suspended state.

Both mechanisms trigger the same surgical recovery. The sentinel runs only while the app is in the background state.

## AV. Reader Blob URLs Survive Warm Resume

When the reader is open during a warm resume, images are not re-fetched. Blob URLs are in-memory object URLs that survive an iOS JS freeze — they don't depend on network connections. Re-fetching would be wasteful and cause a visible flash as pages reload.

## AW. Cloudflare Retry Is Provider-Owned

When any request marked `cloudflareProtected: true` receives a Cloudflare block (503 + Cloudflare headers), the provider owns the solving and retry strategy. The Cloudflare gate is app-wide — while solving is in progress, new app-level requests (user-initiated searches, new manga opens, new chapter opens) are dropped, not queued. However, the provider's own in-flight operations (e.g. parallel chapter list fetches in comix rule 5) can wait for solving to complete and retry their failed requests — these are not "new" requests, they are continuations of an operation already in progress. The app stays responsive: the user can keep interacting (typing, toggling filters, scrolling). Once solving completes, each app-level caller is responsible for retrying if still relevant: search fires with the current query + filters (naturally coalesced), the manga view re-fetches chapters if still mounted, the reader's observer re-fires for still-visible images. If the caller is no longer active (user navigated away), nothing retries — the request is simply gone. The provider signals solving status to the app (see comix rule 6 for the SSE implementation). If solving fails, the error propagates to the caller that triggered the solve.

Cloudflare solving happens silently — no toast is shown until the user actually hits a blocked resource. If a background restore triggers Cloudflare, solving starts but the user isn't interrupted. The toast only appears when the user's foreground action is blocked: swiping back to a view that can't load, or scrolling past loaded images into a chapter/image that's waiting for Cloudflare to resolve.

## AX. Loading Watchdog Is a Bug Detector

If `isLoading` stays true for more than 15 seconds, a watchdog force-resets the search state to idle. This is a safety net for state machine bugs — every normal code path (success, error, abort) should clear loading state well before 15 seconds. If the watchdog fires, it logs a `console.error` with the stuck state for debugging and shows "Something went wrong — pull down to refresh." The watchdog should never fire in correct code.

## AY. Transient vs Permanent Errors on Pagination

When loading the next page of search results fails:
- **Transient** (upstream with status 408, 429, 500, 502, 503, 504, or network, or timeout): page counter rolls back, `hasMore` stays true, toast shows "Slow connection, scroll to retry." User can retry by scrolling to the sentinel again.
- **Permanent** (upstream with status 400, 403, 404, etc., or parse): `hasMore` set to false, pagination stops, toast shows "Failed to load more results." User keeps existing results.

Transient/permanent classification operates on `AppError` (see AZ), not on raw status codes. `isTransient(error: AppError) → boolean` is a single function — no duplication between layers.

All errors are logged with full context (URL, status, response body snippet, timestamp) regardless of transient/permanent classification.

## AZ. Error Types Are a Tagged Union

All errors are categorized into 5 kinds: `upstream` (HTTP error, carries status code), `timeout` (request exceeded dynamic timeout), `network` (TypeError — CORS or no connection), `cloudflare` (503 + Cloudflare header), `parse` (response received but couldn't be parsed — the upstream returned malformed data). Each kind maps to a specific user-facing message: upstream → "Server error ({status})", timeout → "Request timed out", network → "Network error — check your connection", cloudflare → "Blocked by Cloudflare — retrying...", parse → "Unexpected response from server". The UI pattern-matches on `kind`. There is no intermediate error type or lossy conversion — the catch block constructs the final `AppError` variant directly.

## BA. Dynamic Fetch Timeout

Individual fetch requests use a dynamic timeout based on recent response times. The app tracks the last 100 response times per provider in IDB and sets the timeout at 3x the rolling average. The rolling average persists across sessions so cold starts benefit from previous session data — no arbitrary default needed after the first session. Each provider builds its own timeout profile independently — switching providers loads that provider's response history. On first use of a provider (no samples), a generous 10-second default is used. This adapts to connection quality — fast connections get tight timeouts, slow connections get lenient ones. This is separate from the loading watchdog (rule AX), which catches stuck UI state, not slow requests.

The app owns all timeout behavior. The server proxy does not enforce a product-level timeout on requests — it defers to the app's dynamic timeout as the single source of truth for when a request is considered too slow.

## BB. Initial Failures Show Persistent Error State, Pagination Failures Show Toast

When the initial search or manga open fails, the app shows a persistent error state with the error kind (timeout / network / upstream) and an explicit "Tap to retry" button. The error stays on screen until the user acts — no disappearing toast for an empty screen. When pagination fails (results already on screen), a transient toast is appropriate since the user already has content to work with.

## BC. Chapter Image Fetch Retries Once Automatically

When loading chapter images, transient errors (408, 429, 5xx, network, timeout) trigger one automatic retry after a 1-second delay. If the retry also fails, the error propagates and the reader shows the persistent error state with retry.

## BD. Provider Unreachable at Boot

If the very first search on cold start fails (no cached results, no session to fall back to), the app shows a persistent error state with the error kind and a "Tap to retry" button — same as rule BB. The app does not crash or show a blank screen. If loading the active provider's JS bundle from IDB fails (corrupted or missing), the app shows "Provider unavailable" with retry. If no provider is installed at all, the app shows an empty state with a prompt to add a provider (see BF). The app requires a network connection to function — there is no offline mode.

## BE. IDB Storage Is Bounded by Design

The app's IDB stores are designed to stay small without needing cleanup or pruning:
- **progress** — one small entry per manga ever read, keyed by `repoUrl:providerId:mangaId` (~50 bytes). 10,000 manga = 500KB.
- **favorites** — user-managed, add/remove manually, keyed by `repoUrl:providerId:mangaId`. Self-bounding.
- **response times** — fixed window of 100 numbers per provider (~800 bytes each).
- **repositories** — user-managed repo URLs with metadata (~200 bytes each). Self-bounding.
- **installed-providers** — one entry per installed provider: id, repoUrl, version, JS bundle (~50–200KB each). Bounded by user action (install/uninstall).

No images or large blobs are stored in IDB — the reader uses in-memory blob URLs that are revoked on cleanup. No TTL-based expiry or cache invalidation is needed. Provider JS bundles are the largest IDB entries but are bounded by explicit user installation.

## BF. First Launch Shows Empty State

On first launch with no installed provider, the list view shows an empty state: "Add a provider to get started" with a button that pushes the repos view. The search bar, filters, and all provider-dependent features are disabled — nothing works without an active provider. This is the only time the app pushes a view automatically outside of session restore.

## BG. Repository and Provider Management

A repository is a URL pointing to an index file (JSON or JS) that lists available providers. Multiple repos can be added — all their providers are listed together. Provider identity is scoped by repo: a provider's unique key is `repoUrl:providerId`, so two repos listing a provider with the same ID are treated as separate providers with no clash. The repos view has an input field at the top for adding repo URLs. On submit, the app fetches and parses the index, listing each provider with its name, icon, language, and version. Repos can be removed — removing a repo does not uninstall providers already installed from it.

Each listed provider has a single action button:
- **Not installed:** + button. Tapping installs the provider (downloads its JS bundle to IDB), the button becomes -, the provider becomes the active provider, and the list view behind the repos view fires an empty-query search with the new provider. Swiping back reveals search results already loaded.
- **Installed:** - button. Tapping shows a confirmation alert ("Uninstall? This will delete all progress, favorites, and settings for this provider."). On confirm, the provider is uninstalled — removes the JS bundle and all associated data (progress, favorites, filters, group blacklist, response times) for that provider. If uninstalling the active provider, the app falls back to another installed provider. If no providers remain, the app returns to the empty state (BF).

The currently active provider is visually marked in the list. Tapping an already-installed provider (not the - button) switches to it — the list view behind reloads with that provider's filters and fires a fresh empty-query search.

Provider updates are automatic. The app checks all repos for newer versions of installed providers at two triggers: cold start (in background, after the existing provider is loaded — see BI) and entering the repos view. If a newer version is found, the updated JS bundle is downloaded and stored in IDB silently — no user confirmation needed. The update takes effect on the next provider load (next cold start or provider switch), not the current session. On success, the repo button shows a notification badge so the user knows an update is ready. On failure, the old version is kept and a toast notifies the user that the update failed.

## BH. Data Isolation Per Provider

All persistent data is scoped by provider key (`repoUrl:providerId`):
- **IDB progress** — keyed by `repoUrl:providerId:mangaId`
- **IDB favorites** — keyed by `repoUrl:providerId:mangaId`
- **localStorage filters** — keyed by `filters:{repoUrl}:{providerId}`
- **localStorage group blacklist** — keyed by `groups:{repoUrl}:{providerId}`
- **IDB response times** — keyed by `repoUrl:providerId`, 100 samples each (see BA)
- **Session snapshot** — includes `activeProviderKey` (see AP)

Switching providers loads that provider's data context; the previous provider's data remains untouched in storage. Each provider has independent search results, filter state, progress, favorites, and group blacklist. There is no cross-provider data sharing.

## BI. Provider Loading at Boot

On cold start, the app reads `activeProviderKey` from the session snapshot. If present, it loads that provider's JS bundle from IDB and initializes it. If the bundle is missing or corrupted, the app shows "Provider unavailable" with retry (see BD). If no `activeProviderKey` is set but providers are installed, the app activates the first installed provider. If no providers are installed, the app shows the empty state (BF). The provider must be loaded before any search, chapter list, or image request can be made — it defines the `MangaProvider` interface the app calls.

## BJ. Server Proxy Is Provider-Agnostic

The server proxy forwards requests to whatever domain the provider specifies via `HttpRequest.url` — it does not hardcode upstream domains. Cloudflare cookie caching and solving are keyed by domain, not by provider. This means two providers on the same domain share Cloudflare cookies, and two providers on different domains solve independently.

## BK. TLS Root CA Distribution

The server exposes the mkcert root CA certificate at a well-known endpoint. This is required for iOS PWA support — iOS devices on the local network must install and trust this CA before the PWA can be added to the home screen or function over HTTPS. Without it, iOS rejects the self-signed certificate and the app is unusable. The endpoint serves the CA as a downloadable PEM file so users can install it directly from the browser.
