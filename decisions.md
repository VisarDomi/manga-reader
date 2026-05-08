# Decisions

This file is the single source of truth for both product behavior and technical
constraints in the root manga-reader repo.

## Investigation and Change Discipline

These rules guide how to investigate bugs, fix regressions, and add features.
They are intentionally general: the goal is to preserve the debugging posture
that keeps changes correct, scoped, and maintainable.

### 1. Logs First, Then Code

Start with the best available evidence before forming a theory. Check service
logs, browser logs, proxy logs, request status codes, and emitted frontend
events before deciding which code is wrong. Logs should tell the story of the
failure path: what was requested, who handled it, what upstream returned, what
was parsed, and what the user-facing state became.

Only move to source code after the observed failure mode is clear enough to
ask a focused code question. This prevents broad speculative rewrites and keeps
the fix tied to the actual behavior.

### 2. Reproduce with the Same Runtime as Production

When behavior depends on browser state, cookies, Cloudflare, signed requests,
headers, storage, or platform quirks, reproduce with the same runtime that the
app uses in production. A local curl, a different browser, or a simplified test
can be useful, but it is not proof if the production path uses a different
runtime.

The strongest proof comes from exercising the same owner that production uses:
the same managed service, the same browser binary, the same proxy route, the
same request headers, and the same parser path. This avoids fixing a simulated
problem while the real path remains broken.

### 3. Separate Observed Facts from Inference

Keep the debugging loop explicit:

1. Record observed facts from logs, runtime output, network traces, or source.
2. State the inference those facts support.
3. Make the smallest change that follows from that inference.
4. Verify the claim through the same path that failed.

Do not present an inference as a fact. If a claim depends on reading between
two facts, label it as an inference until it is verified.

### 4. Fix the Owning Boundary

A good fix changes the layer that owns the broken contract. Do not patch around
bad data in a downstream consumer if an upstream parser owns that data. Do not
make UI state responsible for protocol details. Do not make a generic proxy
understand product behavior. Do not make a provider responsible for cache,
retry, or resource policy that belongs to the server.

Before editing, identify:

- the data contract that changed or was misunderstood
- the component that owns that contract
- the consumers that should remain ignorant of the implementation detail
- the single place where the invariant should be enforced

The result should make later changes easier to reason about, not merely make
the current symptom disappear.

### 5. Avoid Monkey Patches

A monkey patch is any fix that makes one observed case pass while leaving the
model of the system wrong. Examples include fallback URL guessing, hardcoded
IDs, duplicated parsing logic, silent retries with unclear ownership, or passing
raw provider-specific details through layers that should not know about them.

If the only apparent fix requires threading a detail through many layers,
pause and reconsider the abstraction. Prefer a small typed capability or
owned request object over prop drilling. The caller should describe intent; the
owner should decide how that intent becomes concrete work.

### 6. Make Logs Match Actual Behavior

Every non-trivial path should log the behavior it actually performed, not a
rough approximation. If a request asks for page 4, logs must distinguish page
4 from page 1. If a response returns pages rather than items, logs must say
pages. If a background warmup skips work because it is cached or already
in-flight, logs must say so.

The question "is it broken, or is it unlogged?" should be answerable quickly.
When it is not, the missing log is itself a bug.

### 7. Proof Before Confidence

Do not stop at "the code looks right." Verify each major claim through a path
close to the user-visible behavior:

- direct upstream checks when upstream behavior is in question
- local proxy checks when proxy behavior is in question
- parser checks against real payloads when schemas change
- service logs after restart when server behavior changes
- runtime interaction when UI behavior or performance is in question

Confidence comes from the chain of evidence matching the chain of ownership.
The final verification should prove both that the original failure is gone and
that the new behavior is observable.

### 8. Preserve Intent over Speculation

User-triggered work and background work may share machinery, caches, and
request paths, but they do not have equal authority. Explicit user intent must
take precedence over speculative work. Background work should speed up likely
future actions; it must not make current user actions wait behind guesses.

### 9. Treat Priority as a Resource Policy

Priority is not a label. It only exists when the system can actually reorder,
replace, pause, cancel, or otherwise yield lower-priority work. If queued or
active work cannot be displaced by more important work, the system does not
have real priority.

### 10. Model Lifecycle State Explicitly

Unknown, loading, ready, stale, failed, and empty are different states. If
those distinctions affect user decisions or debugging, they should be modeled
directly rather than inferred from placeholder values like `0`, `null`, or an
empty collection.

### 11. Validate Shared Work Before Reuse

Joining or reusing inflight work is correct only when that work still matches
the current intent and state. Shared work needs validity checks. Reuse without
those checks can turn an optimization into a correctness bug.

### 12. Keep Control Near the Resource

The layer that owns an expensive or fragile resource should own the policy for
using it: queueing, caching, cancellation, retry, and observability. Higher
layers should express intent and consume typed results, not micromanage the
mechanism.

### 13. Verify the Real Interaction Pattern

A feature can look correct under slow, calm usage and fail under the actual
workflow. Verification should include the way the user naturally stresses the
system: fast scrolling, repeated navigation, interrupted work, recovery, and
other realistic interaction patterns.

### 14. Log Decisions, Not Only Outcomes

Outcome logs show what happened. Decision logs show why it happened. Systems
with queues, caches, retries, cancellation, or background work should log when
work is queued, skipped, reused, cancelled, promoted, or rejected so scheduling
and state bugs can be reasoned about from evidence.

### 15. Keep Enrichment off the Critical Path

When adding richer data to an existing fast interaction, treat the new data as
optional enrichment unless it is required for the first useful render. The core
interaction should stay owned by the fastest existing path. Enrichment can run
asynchronously, populate typed state when ready, and expose logs that prove
whether it affected the critical path.

### 16. Parse at the Earliest Data Owner

Avoid waiting for UI-shaped artifacts when the same data exists earlier in the
pipeline. If a document response, JSON payload, or typed cache owns the data,
parse it there instead of waiting for DOM readiness, component rendering, or a
downstream representation. The earlier owner is usually faster, easier to log,
and less coupled to presentation details.

### 17. Put Shared Behavior at the Smallest Common Owner

When behavior appears in multiple surfaces, do not duplicate it in every
caller. Move the shared observation or mechanism to the smallest common owner,
and keep policy in the layer that already owns policy.

For example, a reusable list can own detecting which rendered items are
visible, while application state owns what visible items mean: prewarm,
restore tracking, cancellation, cache policy, or no action at all. The common
owner should expose intent, not absorb unrelated policy.

### 18. Separate Navigation State by Domain

Navigation can span more than one state domain. A view stack should own which
screen comes next; feature state should own feature-specific restoration data.
Do not force domain payloads into a generic route or view stack just because
they are needed during back navigation.

When moving backward through a feature-specific chain, model that chain in the
feature owner. This keeps view transitions simple and makes restoration
explicit instead of inferred from incidental UI state.

### 19. Persist the Entry Context, Not Only the Current Object

Restore state should preserve the user's entry context as well as the current
active object. In flows that move deeper through related items, the current
item and the item that anchored the original list/search context can be
different.

If restore, scrolling, or recovery needs to return to the origin surface, store
that origin intentionally. Do not assume the deepest active object is the right
target for every recovery path.

### 20. Model Important History Directly

If back or restore behavior matters, store the history as typed state. Do not
reconstruct important navigation history from DOM position, current search
results, visible cards, or other incidental UI state.

Direct history state makes stack depth, restore order, and failure behavior
clear. It also gives logs and session snapshots a concrete thing to verify
instead of relying on fragile inference.

### 21. Normalize Persisted Navigation Before Replaying It

Persisted navigation is historical data, not automatically valid runtime
state. When restoring into a nested or overlay view, rebuild the stack for the
target view's ownership model instead of replaying the saved stack literally.

Transient views and duplicate active views should be removed before restore.
Verify the result with navigation logs so each back action lands on the owner
it is supposed to reveal.

### 22. Match the Source Product's Interaction Model

When integrating with an upstream product, parity requires matching the
interaction model, not only the first response. If the source UI supports
pagination, nested loading, sorting, lazy enrichment, or multiple "load more"
paths, the integration must account for those paths before claiming feature
parity.

Treat visible upstream controls as evidence of data boundaries. A single
successful request proves only that one boundary works; it does not prove the
full user-visible state has been reproduced.

### 23. Log Completeness, Not Only Success

For paginated, nested, or merged data, success logs must show completeness
signals. Log page counts, node counts, max depth, merge/fill counts, and any
remaining unavailable or inconsistent upstream counts. A `200` response with
some items is not enough evidence for a complete feature.

Good completeness logs make it possible to answer whether missing UI is caused
by a failed request, an unvisited pagination path, a parser bug, a dedupe bug,
or an upstream counter that includes data the API does not expose.

### 24. Normalize Complex Upstream Shapes at the Boundary

When an upstream API exposes data through several shapes or endpoints, normalize
that complexity at the integration boundary. The owner closest to the upstream
should handle pagination, nested traversal, merging, deduplication, unavailable
items, and schema quirks.

Downstream UI should receive a stable display contract. It should not need to
know which upstream endpoint supplied each field or which recovery path filled
missing parts of the shape.

### 25. Distinguish Not Fetched from Not Available

Missing data can mean the integration failed to fetch it, or it can mean the
upstream counts data that is not available through its visible API. Those are
different states and must be represented separately.

Use logs and typed stats to distinguish fetch gaps from unavailable upstream
items. This prevents chasing false bugs and makes residual risk explicit.

### 26. Use the Upstream Client as Evidence

When an upstream product's behavior is unclear, inspect the client it ships.
Its routes, query parameters, cache keys, and interaction handlers are stronger
evidence than guessed endpoint variants.

Prefer following proven client paths over probing many speculative URLs. Once
the source client's data flow is known, implement against that flow and verify
through the local integration boundary.

### 27. Log Ownership Boundaries

Logs should identify the owner that made a state decision, not only the final
symptom. For every important mutation, log the source, reason, affected
resource, and before/after values that prove which owner acted.

This is especially important for shared surfaces such as reader layout,
progress, navigation, queues, caches, and background hydration. A useful log
timeline should answer: who planned the work, who queued it, who skipped or
accepted it, who wrote state, and whether any programmatic scroll or navigation
write occurred.

### 28. Observers Are Not Authority

Visibility, intersection, scroll probes, and page measurements are observations.
They can report facts and trigger the owning state machine, but they should not
become the authority for unrelated state domains.

For example, a visible page can inform progress tracking, chapter title state,
or layout scheduling, but it should not directly own virtual layout, scroll
geometry, or navigation restoration. If an observer starts suppressing,
overriding, or rewriting another domain's state, the ownership model is wrong.

### 29. Reader Layout Has One Writer

Reader virtual geometry has one writer: the layout owner. Virtual slot
positions, chapter heights, total scroll height, and scroll-preserving anchor
restores must go through the same layout path.

Chapter hydration may make better height data available, and scrolling may
create new measurement evidence, but both are inputs to layout. They should
schedule layout work instead of independently changing scroll geometry. This
keeps the reader debuggable: layout writes can be found in one log path, and
programmatic scroll writes can be treated as high-signal events.

### 30. Do Not Mutate Scroll Geometry During Momentum

On iOS, changing content above or around the viewport during active scroll or
momentum can interrupt the user's flow even when the math is correct. Scroll
compensation that preserves a DOM anchor can still feel like a jump if it runs
while Safari is applying momentum.

Prefer preparing and promoting reader layout during idle time. If background
chapter hydration changes reserved space, queue the layout owner to collapse or
grow that space after the DOM has rendered and before the user reaches it.
Active scroll should update observations and priorities; idle layout should own
geometry mutation.

### 31. Synthetic Reproductions Prove Narrow Claims Only

A reduced test app is useful for proving one isolated claim, such as whether
iOS Safari reacts badly to prepending content during scroll. It is not proof
that the production bug has the same full cause.

After a synthetic claim is proven, bring the result back to production logs and
verify the complete interaction path. The production path may include planner
state, hydration timing, saved progress, virtual windows, image loading, and
navigation ownership that the reduced test does not model.

### 32. Treat Large Restored State as a Stress Test

Large restored state can expose real main-thread costs even when it is not the
root cause of a regression. A 1000-result search list, a 3000-chapter detail
view, or a large comments tree is useful evidence about broad reactive
invalidation, DOM cost, and gesture sensitivity.

Do not confuse the stressor with the owner of the bug. If a heavy search result
set is restored while favorites owns the route, the fix is restore ownership,
not hiding or hibernating views. Keep the stress case as performance evidence,
but fix the state owner that caused the wrong work to run.

### 33. Top-Level Views Stay Mounted Unless Behavior Explicitly Changes

The list, favorites, manga detail, reader, and comments surfaces are navigation
layers, not disposable route pages. They may be visually covered by a higher
layer and still need to preserve scroll, gesture continuity, and peek-back
behavior.

Do not add hibernation, parking, inert modes, or conditional mounting for a
top-level view as a performance fix unless the behavior change is explicitly
approved. If a covered view is doing expensive work, fix the owner that is
committing the work; do not make mount lifetime responsible for correctness.

### 34. Avoid Broad Svelte State Broadcasts

In Svelte 5, a single broad `$state` write can wake many `$derived` chains and
component instances. High-volume producers should commit deliberate snapshots,
and consumers should subscribe to keyed data when they only need one key.

Known good patterns in this app:

- collect chapter pages in a local owner and commit page 1 plus the final full
  chapter snapshot, instead of writing every fetched page into broad state
- keep chapter-list grouping/filter/gap work memoized around the chapter list
  and filter inputs
- subscribe manga cards to keyed progress and chapter-stat snapshots instead
  of whole progress/stat records
- keep reader-visible observations reader-owned during scroll and commit
  manga-detail scroll targets at discrete boundaries

### 35. Gestures Own the Frame Budget While Active

During an active swipe or momentum scroll, gesture movement should be direct
DOM/CSS variable work. Other owners must avoid large `$state` commits, DOM
scans, image-start bursts, or result application that can compete with the
interaction.

`pauseBackgroundWork` and related foreground gates are about frontend commit
ownership. Backend work does not directly block the frontend main thread, but
frontend application of backend results can. Logs should distinguish queued,
deferred, resumed, skipped, and committed work so jank windows can be tied to
the owner that spent the frame budget.

### 36. Restore Only the Owning Surface

Search and favorites are sibling roots. Restoring favorites must not replay
search just because an older session contains search context. Restoring search
may replay search. Restoring manga or reader may replay search only when the
back stack says search/list owns the origin path.

Persisted search context is domain state for the search surface, not global app
state. A restore path must first identify the current surface and back stack,
then replay only the domain owners needed for that path.

## Product Decisions

These are app-level behavior decisions that drive UX, persistence, navigation,
loading, and recovery behavior.

## AA. NSFW Genres Auto-Excluded on First Install

When a provider is used for the first time (no prior filter state for that provider), the app auto-excludes all genres that the provider marks as NSFW. The app does not know which genres are NSFW by name — it asks the provider which genres are NSFW and excludes them. After this one-time seeding, the user can toggle any of them freely. If the provider already has saved filters, this seeding is skipped entirely. This triggers independently per provider — installing a second provider seeds its NSFW genres even if the first provider's filters already exist.

## AB. Genre Filters Are 3-State Toggles

Each genre filter cycles through three states on tap: empty (no filter) → include → exclude → back to empty. This applies to all genre terms, including the NSFW ones seeded in rule AA. Types and statuses are simpler binary toggles (on/off). Long-press is not used on filter chips — it is reserved for the chapter list's group items, where it shows a block/cancel option to add the group to the provider-wide blacklist (see AF).

## AC. Filter and Search Interaction

All search inputs — filter toggles (genre, type, status) and text input — go through the same 500ms debounce. Every change (keystroke, filter toggle) restarts the debounce and aborts any in-flight search request. After 500ms of no changes, a new search fires from page 1 with the current text + current filters combined, replacing the entire result set. Any in-flight pagination (rule AD) is implicitly abandoned because the results are replaced. Pressing enter skips the debounce and fires immediately.

The fetch is always non-blocking — the UI stays responsive while results load. The user can freely mix toggling filters and typing without the UI freezing or results resetting mid-edit. Filters and query persist to localStorage, scoped per provider (see BH).

## AD. Search Pagination with Deduplication

Search results are paginated from the upstream provider. Each page append deduplicates by manga ID to prevent duplicates across pages. The app relies on the provider's `hasMore` flag to know when to stop — it never hardcodes a page size threshold itself. The provider returns `hasMore` with each page of results; the app uses it as-is.

## AE. Infinite Scroll Trigger Zone

The infinite scroll sentinel fires 5 viewports before the user reaches the bottom of the list (rootMargin: 500% 0px). This aggressive prefetch means the user almost never sees a loading state during normal scrolling — new pages load well before they're visible.

## AS. Manga Cards Are Cover-First

Manga cards prioritize the cover image — no title, no author, no badges, no padding between cards. The only overlay is compact chapter-progress metadata at the bottom of the card (see BS). This is a deliberate deviation from standard manga apps (Tachiyomi, MangaDex) which show title text and metadata below each card. The tradeoff: less information per card, but more covers visible at once and faster visual scanning. The user identifies manga by cover art, not by reading titles.

## BS. Manga Cards Show Read, Filtered Max, and Upstream Max

Manga cards show three chapter numbers as `read / filtered max / upstream max`.

- **Read:** The latest locally saved reading progress for this manga. If the manga has no saved progress, this is `0` on a red badge. If it has saved progress, the badge is green.
- **Filtered max:** The highest chapter number known after applying the current group filters. This can only be known after the manga's chapter list has been loaded or warmed. Until known for the current filter state, it is shown as `0`; while the request is in flight the badge is yellow, and once known the badge is green.
- **Upstream max:** The max/latest chapter number returned by the provider's search/list API.

Filtered max values are cached per manga in localStorage, but only displayed when their cache key matches the current provider-wide blocked groups, the manga's saved per-manga group selection, and the upstream max currently shown by the provider list. If filters or upstream max change and no fresh chapter list has been loaded for that state, the cached value is treated as unknown rather than stale.

Visible manga cards may warm chapter metadata in the background. The backend owns signed chapter-list fetching, inflight joining, and short-lived chapter-list caching; the frontend owns applying local group filters and writing the filtered max cache. Opening a manga refreshes the same cache from the loaded chapter list and remains the authoritative foreground path.

## AF. Chapter Group Filtering

Chapter filtering is a single pipeline: raw chapters in, filtered/deduped/sorted chapters out. The pipeline takes three inputs — the raw chapter list, the provider-wide blacklist, and the per-manga group selection — and produces one output. The stages are:

1. **Blacklist filter:** Remove chapters whose group is in the provider-wide blacklist (hide this scanlation group's chapters across all manga for the active provider — see BH). In the per-manga group selector, blacklisted groups appear grayed out but remain selectable.
2. **Per-manga group selection:** If the user has selected specific groups for this manga, keep only chapters from those groups. Selecting a blacklisted group overrides the blacklist for that manga only.
3. **Dedup by chapter number:** When multiple groups have the same chapter number, the latest upload wins.
4. **Sort descending:** Chapters are sorted by number, newest first.

Tests assert the pipeline's end state for each behavior.

## AG. Chapters Commit Page 1 Then the Final Snapshot

When opening a manga, the provider yields chapters in descending order (newest
first). The app commits page 1 immediately so the visible top of the chapter
list appears fast, then keeps later pages in a local chapter-ingestion owner
until the full list is ready. The final full list is committed once.

This avoids writing thousands of intermediate chapter-list states into Svelte
while preserving the useful first render. The provider owns the pagination
strategy. The app owns deduplication by chapter ID and re-applies group
filtering and sorting when it commits the display snapshots. If some pages fail
but others succeed, the app shows what it got; partial data is better than
nothing.

## AH. Progress Is Tracked Per Manga

Reading progress stores chapterId, chapterNumber, pageIndex, and scrollOffset (pixel offset within the current page), keyed by `repoUrl:providerId:mangaId` (see BH). This means progress remembers which chapter you were on, which page, and exactly where on that page — but only the latest position per manga per provider, not per chapter.

## AI. Progress Synced with 500ms Debounce

Scroll-based progress updates are debounced at 500ms before writing to IndexedDB. This keeps progress close to the user's visible position without writing on every scroll event. Closing the reader flushes the latest tracked page immediately, so swipe-back does not wait for the debounce.

## AJ. Current Page Detected at 1/3 Down the Viewport

The visible page is determined by which page element sits at 1/3 of the viewport height from the top — not the center, not the top edge. This accounts for the natural reading position where your eyes focus below the top of the screen.

## BL. Reader Image Prefetch Margin

Reader page images are scheduled by the reader memory manager from current virtual geometry, not by per-chapter IntersectionObservers. On each reader render or scroll pass, mounted page elements inside a 14-viewport image window are prioritized by distance from the visible-page probe. Blob URLs outside that image window are revoked and removed from their image elements.

This image window is separate from the reader chapter window in AK and from list-view infinite scroll in AE. Chapter slots decide which chapters exist in the DOM; the memory manager decides which mounted page images should hold blob URLs.

## AK. Reader Uses Virtual Chapter Windows

The reader lays out all chapters in one virtual coordinate space, but only mounts chapter slots near the viewport. Slot planning is owned by `ReaderWindowManager`:

- **Load window:** chapters whose virtual slot intersects 10 viewports before or after the current viewport are wanted. Wanted placeholder slots are fetched by priority.
- **DOM keep window:** slots are kept mounted while they intersect 12 viewports before or after the current viewport, or while they are wanted by the load window.
- **Image window:** mounted page images are loaded and retained within the 14-viewport image window described in BL.

Priority is recalculated from the current virtual viewport. Distance to the viewport is the base priority; the current scroll direction biases work toward previous chapters while scrolling up and next chapters while scrolling down. Nearby placeholder slots are fetched concurrently up to the current scheduler limit.

When a chapter hydrates, its reserved virtual height is preserved first so hydration does not mutate scroll geometry. Actual measured heights are promoted later by the layout owner during idle layout promotion.

## BM. Chapter Loading Priority and Boundaries

When opening a chapter, the selected chapter loads first and is placed into the virtual layout. The reader then reconciles the virtual window from the restored or initial scroll position and fetches nearby placeholder chapters according to AK. Fresh opens, restores, fast upward scrolls, and fast downward scrolls all use the same virtual-window planner.

Chapter change is detected from the visible page probe at one-third down the viewport (see AJ), with `layoutChapterId` and `currentChapterId` used as preferred ownership hints. Visibility is an observation; it can update progress and title context, but it does not own virtual layout.

A visual divider separates chapters in the reader.

## BP. Image Fetch Failure Recovery

Image fetch failures are handled differently based on the error:

- **Image blob fetch failure:** The failure is logged with `img-fail`, the image is left without a blob URL, and it does not block adjacent chapter loading.
- **Retry path:** Because image loading is geometry-driven, a later render or scroll pass can attempt the image again if the page is still inside the image window and no blob URL or in-flight load exists for that page.
- **Slow connection detection:** If 3+ image fetches fail within 10 seconds, show a one-time "Slow connection — images may not load" toast per session.

## BQ. Image Proxy Responses Are HTTP-Cached for 24 Hours

The server's image proxy sets `Cache-Control: max-age=86400` on every proxied image response. This works as a complement to BO: when the reader closes, blob URLs are revoked and memory is freed — but the browser's HTTP disk cache retains the image bytes for 24 hours. If the user reopens the same chapter, new blob URLs are created but the underlying `fetch()` calls hit the disk cache instead of round-tripping through the server to the CDN. This gives the memory benefits of blob revocation (BO) without the network cost of re-fetching on reopen.

## BN. Details List Syncs with Reader Position

When entering the reader, the details view captures its current scroll position (as a viewport ratio). While reading, every chapter change updates the details view's scroll target to the new chapter. When swiping back to details, the chapter list scrolls to show the chapter you were last reading — not the one you originally opened from.

## BO. Reader Cleanup on Close

When the user swipes back from the reader, cleanup happens in a specific order to avoid visual glitches:

1. **During swipe animation:** nothing happens — the reader stays visually intact while sliding away.
2. **Animation completes:** the reader close handler runs.
3. **Close snapshot:** capture the visible page, track it with `source: close`, and flush progress immediately instead of waiting for the 500ms scroll debounce.
4. **Reader state cleanup:** abort image work, revoke blob URLs, clear loaded chapter data, destroy the page tracker, then pop the view stack back to manga details.

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

## AO. View Mode Owns the Current Surface, View Stack Owns Back

`viewMode` is the current surface. `viewStack` contains only the back stack
behind that surface. Search and favorites are sibling roots: switching between
them resets the stack instead of placing one behind the other.

Valid common states are:

- `viewMode=list`, `viewStack=[]` — browsing search results
- `viewMode=favorites`, `viewStack=[]` — browsing favorites
- `viewMode=manga`, `viewStack=[list]` — details opened from search
- `viewMode=manga`, `viewStack=[favorites]` — details opened from favorites
- `viewMode=reader`, `viewStack=[list, manga]` — reader opened from a search details path
- `viewMode=reader`, `viewStack=[favorites, manga]` — reader opened from a favorites details path
- `viewMode=chapter-comments`, `viewStack=[..., manga, reader]` — comments opened from the reader path

Back (swipe or button) pops one level from `viewStack`. Peek-back uses the same
stack, so the covered surface must remain mounted and visually stable during a
gesture. Session restore may rebuild stacks for the target surface, but it must
not invent a search owner behind favorites.

## AP. Session Snapshot Saves Navigation and the Owning Search Context

The session snapshot is a single object in localStorage with these fields:
`viewMode`, `viewStack`, `activeManga`, `mangaStack`, `targetMangaId`, and
`searchContext`.

View transitions save immediately. Visible manga tracking is debounced and
updates `targetMangaId`, which points to the origin manga for restore or
back-stack recovery. `mangaStack` stores nested manga-detail history directly
instead of reconstructing it from DOM state.

`searchContext` is saved only when search/list owns the current path:
`viewMode === list` or `viewStack` contains `list`. Favorites does not own
search context. Restoring favorites must not replay a stale 1000-result search
behind it.

## AQ. Session Restore Is Automatic and Abortable

On app launch, if a session snapshot exists, the app restores it automatically. While restoring, a passive "Restoring last position..." toast is shown. If the user takes any action during restore (scrolls, taps a manga, changes view, or starts a new search), the restore is cancelled silently — user action always wins. Each phase is independently abortable.

All restore sequences require the active provider to be loaded first (see BI).
Each sequence restores only the owners implied by `viewMode` and `viewStack`:

**Search/list restore:**
- Replay the saved search context, or run the current empty/default search.
- If `targetMangaId` exists, paginate until the target is found and scroll to it.

**Favorites restore:**
- Set `viewMode=favorites` with an empty back stack.
- Load favorites from IDB.
- Do not replay search. Favorites is a root surface, not a child of search.

**Manga restore:**
- Restore `activeManga`, `mangaStack`, group selection, and chapters per AG.
- Preserve the saved back stack when present.
- Replay search in the background only if the back stack contains `list`.

**Reader or chapter-comments restore:**
- Rebuild the stack without transient reader/comments entries, then set the
  foreground reader path.
- Restore manga detail for the reader path, then restore reader position from
  IDB progress (see AR).
- Replay search in the background only if the rebuilt stack contains `list`.
- If the snapshot was comments, open comments after reader restore.

User action still cancels restore. Search replay and pagination are abortable,
and foreground reader work takes priority over background restore work.

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
- **Permanent** (upstream with any other status — 400, 401, 403, 404, 405, 406, 410, 422, etc. — or parse): `hasMore` set to false, pagination stops, toast shows "Failed to load more results." User keeps existing results.
- **Cloudflare** errors never reach pagination — the provider handles them via AW before they bubble up. If a cloudflare error does reach `isTransient`, it returns false (stop pagination) as a safe fallback — the user can't solve cloudflare by scrolling.

Transient/permanent classification operates on the error kind (see AZ), not on raw status codes. The classification logic exists in one place — no duplication between layers.

All errors are logged with full context (URL, status, response body snippet, timestamp) regardless of transient/permanent classification.

## AZ. Error Types Are a Tagged Union

All errors are categorized into 5 kinds: `upstream` (HTTP error, carries status code), `timeout` (request exceeded timeout), `network` (no connection or CORS), `cloudflare` (Cloudflare block), `parse` (response received but unparseable). Each kind maps to a user-facing message: upstream → "Server error ({status})", timeout → "Request timed out", network → "Network error — check your connection", cloudflare → "Blocked by Cloudflare — retrying...", parse → "Unexpected response from server". No error information is lost in classification — HTTP errors preserve their status code, and the UI pattern-matches on kind.

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

## Technical Decisions

Non-obvious constraints from upstream services, platforms, and protocols that drive implementation choices. These are things you can't derive from reading the code alone.

## D1. Cloudflare Binds cf_clearance to User-Agent

Cloudflare's cf_clearance cookie is bound to the User-Agent string used during the challenge solve. Subsequent requests must send the exact same UA or the cookie is rejected. This means the proxy must track which UA the headless browser used during solving and replay it on every CF-protected request.

## D2. CDN Hotlink Protection Uses Referer

The image CDN (wowpic*.store) rate-limits requests that send a bare origin (`https://comix.to`) as Referer. Requests with the full chapter page URL (`https://comix.to/title/{mangaId}/{chapterId}-chapter-{number}`) are not rate-limited. The CDN starts throttling after ~7 requests with a bare referer — TTFB degrades from 100ms to 5s+, then streams timeout. Discovered 2026-03-25.

## D3. iOS PWA Freezes JS Without Firing visibilitychange

When iOS backgrounds a PWA, it freezes the JS event loop entirely. On resume, `visibilitychange` often doesn't fire. The workaround is a 1-second setInterval sentinel that detects clock drift — if 3+ seconds passed since the last tick, JS was frozen. Both mechanisms (visibilitychange and sentinel) trigger the same recovery path.

## D4. iOS WebKit Touch Handler Desync After Resume

After an iOS PWA warm resume, WebKit's internal touch event handler can desync from the scroll container. Toggling `overflow: hidden` then back forces WebKit to recreate the handler. Without this, scroll containers appear frozen after resume despite the DOM being intact.

## D5. Reader Does Not Use IntersectionObserver for Image Ownership

Reader image and chapter loading are driven by virtual geometry and the reader
memory manager, not by per-page IntersectionObservers. The app may still use
IntersectionObserver for simple sentinels or boundary observations elsewhere,
but reader page image ownership comes from the virtual window described in AK
and BL.

## D6. comix.to Embeds Chapter Images in Two HTML Formats

comix.to embeds chapter image data in `<script>` tags in two formats that vary between renders: escaped (`\"images\":[...]` inside JSON strings) and unescaped (`"images":[...]` in inline script blocks). The parser tries both patterns.

## D7. Cloudflare Cookie Domain Inheritance

Cloudflare sets cf_clearance on the parent domain (`.comix.to`), covering all subdomains. The cookie cache looks up by exact domain first, then tries the parent — so a request to `static.comix.to` finds cookies cached under `comix.to`.

## D8. Provider Bundles Served No-Cache

Provider JS bundles are served with `Cache-Control: no-cache` so updates take effect immediately without cache busting. Frontend immutable assets (content-hashed by Vite) are cached forever.

## D9. HTTPS Required for iOS PWA

iOS Safari requires HTTPS for PWA installation (Add to Home Screen). The server uses mkcert certificates. The manga-reader and gallery-reader backends crash without certs (no HTTP fallback).

## D10. Server Runs Under xvfb-run

The manga-reader systemd service is wrapped in `xvfb-run` because Playwright/CloakBrowser needs a display for Cloudflare solving. Never kill the process directly or restart with nohup — always use `systemctl --user restart manga-reader`.

## D11. imageProxy Batches Success Logs

Individual image proxy successes accumulate in a batch. A summary (count, avg ttfb, avg size, peak inflight) flushes when activity quiets down (1 second with no new result). Failures are always logged immediately and individually. This reduced log volume from ~6,500 lines/day to ~50-100 batch summaries.

## D12. LogEvent Is a Discriminated Union

Every frontend log event is a variant of the `LogEvent` union type. Adding a new event requires adding it to the union first — the compiler forces every emitter to supply the correct payload. The `emit` function extracts the `event` field as the first arg and type-checks the payload against the event name.

## D13. Image Load Success Logged Server-Side Only

Client-side `img-ok` was removed. The server's imageProxy already logs every proxied image fetch (see D11). Only `img-fail` is logged client-side because client-only failures (CORS, AbortError, blob creation) never reach the server.

## D14. comix.to Chapters API Requires Per-Manga Signed `_` Parameter

The `/api/v2/manga/{id}/chapters` endpoint returns application-level 403 (HTTP 200, JSON `status: 403`) without a `_` query parameter generated by obfuscated client-side JS. The signature is per-manga (tied to the manga ID), but opaque to other URL params — limit, page, and order can be changed freely. The signature is stable within a browser session. The search endpoint does not require signing.

## D15. NavigationScheduler Is the Single Owner of Page Navigation

Only NavigationScheduler creates and navigates Playwright pages. Both user requests (signedFetch) and background prewarming go through its priority queue. USER priority items sort before PREWARM items. Concurrency is capped at 4 workers. Pages are created per-request and closed immediately after sig capture — there is no page pool. Multiple requests for the same mangaId piggyback on the in-flight or queued item rather than creating duplicate work.

## D16. Chapter Log Ownership: Consumer, Not API Layer

The `chapters-page` and `chapters-done` log events are emitted by `MangaState.consumeChapterStream` (the consumer), not by `fetchChapterList` in the API layer. The API generator is called from two contexts (display load and restore probe) — the consumer owns the context and therefore owns the logging.

## D17. BrowserSession fetchPage Stays on comix.to Root

The persistent `fetchPage` (used for `page.evaluate(fetch(...))` calls) stays navigated to `https://comix.to`. It never navigates away — only the ephemeral pool pages navigate to manga title pages for signature capture. This keeps the fetchPage's cookies and JS context stable for chapter fetches.

## D18. CloakBrowser CPU Mitigation Under Xvfb

Xvfb provides no vsync signal. Chromium's GPU compositor expects vsync to throttle frame production — without it, `SwapBuffers` returns instantly and the GPU process busy-loops (Chromium bugs #170681, #518209). Three layers of mitigation reduce total CloakBrowser CPU from ~545% to ~7%:

1. **`--disable-gpu --disable-gpu-compositing`**: Reduces GPU process from 500% to ~70%. CloakBrowser's fingerprint patches force some GPU init via a compiled-in `gpu-preferences` protobuf, so the process still spins but at a fraction. Never add `--ignore-gpu-blocklist` back.
2. **CDP `Emulation.setScriptExecutionDisabled`**: Kills page-originated JS (timers, animations, ads). `page.evaluate()` still works — it uses CDP `Runtime.evaluate` which bypasses this restriction.
3. **Navigate fetchPage to lightweight same-origin URL** (`/api/v2`): After init on comix.to homepage (to load cookies), redirect to a minimal JSON endpoint. This eliminates CSS animation and rendering overhead that persists even with JS disabled. The page retains comix.to origin and cookies, so `page.evaluate(fetch(...))` works.

Tested and rejected: `--disable-software-rasterizer` (no effect), `--in-process-gpu` (moves spin into main process, worse for stability), `setScriptExecutionDisabled` alone without navigating away (28% CPU from CSS/rendering).

## D19. No Page Pool — Create and Close Per Sig Capture

NavigationScheduler creates a fresh page per sig capture and closes it immediately after. No page pool. Playwright persistent contexts leak memory via internal request/response bookkeeping that only flushes on context disposal (playwright#6319), and `page.evaluate()` on intervals leaks in the Node process (playwright#21345). Pooled pages on `about:blank` still hold live Chromium renderer processes (~60-170 MB each). Creating a new page within an existing context costs ~50-100ms — negligible vs the 500-900ms sig capture navigation. The tradeoff: slightly higher latency per sig, but zero idle CPU/memory from stale renderer processes.

## D20. Chromium Spare Renderer Process Is Expected

After all sig capture pages are closed, one renderer process remains at 0% CPU (~62 MB). This is not a leak — it is Chromium's `SpareRenderProcessHostManager`, which pre-creates one warm renderer so the next `context.newPage()` is instant instead of cold-starting a process. Exactly one spare, always. Can be disabled with `--disable-features=SpareRendererForSitePerProcess`, but we keep it because it speeds up the next sig capture and costs nothing at idle.
