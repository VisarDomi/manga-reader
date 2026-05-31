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
pages. If a cache read waits on an in-flight owner or starts missing data
work, logs must say so.

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
visible, while application state owns what visible items mean: restore
tracking, cancellation, cache policy, or no action at all. The common
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

### 22. Restore Foreground First, Hydrate Behind It

Session restore is a foreground ownership problem before it is a data-loading
problem. On cold start, the restore owner must recreate the saved visible
surface and back stack immediately, then let each domain hydrate its own data
behind that shell.

Do not make a surface wait to become visible until search replay, manga
hydration, reader image metadata, comments, or backing layers finish. The user
should land on the saved foreground first. If a backing layer needs data before
its saved scroll can be applied, that layer owns a pending restore target and
applies it when its height/data is ready.

For nested manga details, each manga layer owns its own scroll snapshot. A
single "current manga scroll" is not enough because the stack can contain
multiple independent manga-detail surfaces. Persist and restore scroll by
layer identity, not by whichever layer happens to be active at shutdown.

### 23. Match the Source Product's Interaction Model

When integrating with an upstream product, parity requires matching the
interaction model, not only the first response. If the source UI supports
pagination, nested loading, sorting, lazy enrichment, or multiple "load more"
paths, the integration must account for those paths before claiming feature
parity.

Treat visible upstream controls as evidence of data boundaries. A single
successful request proves only that one boundary works; it does not prove the
full user-visible state has been reproduced.

### 24. Log Completeness, Not Only Success

For paginated, nested, or merged data, success logs must show completeness
signals. Log page counts, node counts, max depth, merge/fill counts, and any
remaining unavailable or inconsistent upstream counts. A `200` response with
some items is not enough evidence for a complete feature.

Good completeness logs make it possible to answer whether missing UI is caused
by a failed request, an unvisited pagination path, a parser bug, a dedupe bug,
or an upstream counter that includes data the API does not expose.

### 25. Normalize Complex Upstream Shapes at the Boundary

When an upstream API exposes data through several shapes or endpoints, normalize
that complexity at the integration boundary. The owner closest to the upstream
should handle pagination, nested traversal, merging, deduplication, unavailable
items, and schema quirks.

Downstream UI should receive a stable display contract. It should not need to
know which upstream endpoint supplied each field or which recovery path filled
missing parts of the shape.

### 26. Distinguish Not Fetched from Not Available

Missing data can mean the integration failed to fetch it, or it can mean the
upstream counts data that is not available through its visible API. Those are
different states and must be represented separately.

Use logs and typed stats to distinguish fetch gaps from unavailable upstream
items. This prevents chasing false bugs and makes residual risk explicit.

### 27. Use Upstream Runtime Capabilities as Evidence

When an upstream product's behavior is unclear, inspect the client it ships.
Its routes, query parameters, cache keys, and interaction handlers are stronger
evidence than guessed endpoint variants.

Prefer following proven client paths over probing many speculative URLs. Once
the source client's data flow is known, implement against that flow and verify
through the local integration boundary.

For Comix, the protected chapter APIs are browser-runtime owned. Direct backend
`fetch` can read public endpoints such as search and manga detail, but direct
fetches to chapter-list and chapter-image endpoints return token/signing
failures. The provider therefore opens the current Comix runtime in
BrowserSession, finds the HTTP client by capability, verifies it with a small
chapter-list probe, and stores that capability on the runtime page. The provider
owns the Comix paths and response normalization; BrowserSession owns the browser
page and calls the provider-resolved runtime HTTP client for protected chapter
data.

This keeps the fragile site-specific part in the provider boundary. If Comix
renames a minified export, the capability probe can still find a working
client. If the runtime shape changes enough that no candidate passes the probe,
the provider fails loudly with resolver logs instead of leaking encrypted or
untyped payloads into the cache.

### 28. Log Ownership Boundaries

Logs should identify the owner that made a state decision, not only the final
symptom. For every important mutation, log the source, reason, affected
resource, and before/after values that prove which owner acted.

This is especially important for shared surfaces such as reader layout,
progress, navigation, queues, caches, and background hydration. A useful log
timeline should answer: who planned the work, who queued it, who skipped or
accepted it, who wrote state, and whether any programmatic scroll or navigation
write occurred.

Cache logs must distinguish `warming`, `not-ready`, `empty`, `ready`, `hit`,
and `promoted`. A cache hit is only truthful when the payload satisfies the
consumer contract; a row existing in SQLite is not enough.

### 29. Observers Are Not Authority

Visibility, intersection, scroll probes, and page measurements are observations.
They can report facts and trigger the owning state machine, but they should not
become the authority for unrelated state domains.

For example, a visible page can inform progress tracking, chapter title state,
or layout scheduling, but it should not directly own virtual layout, scroll
geometry, or navigation restoration. If an observer starts suppressing,
overriding, or rewriting another domain's state, the ownership model is wrong.

### 30. Reader Layout Has One Writer

Reader virtual geometry has one writer: the layout owner. Virtual slot
positions, chapter heights, total scroll height, and scroll-preserving anchor
restores must go through the same layout path.

Chapter hydration may make better height data available, and scrolling may
create new measurement evidence, but both are inputs to layout. They should
schedule layout work instead of independently changing scroll geometry. This
keeps the reader debuggable: layout writes can be found in one log path, and
programmatic scroll writes can be treated as high-signal events.

### 31. Do Not Mutate Scroll Geometry During Momentum

On iOS, changing content above or around the viewport during active scroll or
momentum can interrupt the user's flow even when the math is correct. Scroll
compensation that preserves a DOM anchor can still feel like a jump if it runs
while Safari is applying momentum.

Prefer preparing and promoting reader layout during idle time. If background
chapter hydration changes reserved space, queue the layout owner to collapse or
grow that space after the DOM has rendered and before the user reaches it.
Active scroll should update observations and priorities; idle layout should own
geometry mutation.

Reader destructive work follows the same rule. During active scroll, the
reader may hydrate wanted images and observe mounted pages, but it may not
physically rebase the runway, retire top/bottom slots, revoke blob URLs, or
remove image `src` values. Those destructive projection and cleanup operations
belong to idle/initial transactions, not scroll ticks.

### 32. Synthetic Reproductions Prove Narrow Claims Only

A reduced test app is useful for proving one isolated claim, such as whether
iOS Safari reacts badly to prepending content during scroll. It is not proof
that the production bug has the same full cause.

After a synthetic claim is proven, bring the result back to production logs and
verify the complete interaction path. The production path may include planner
state, hydration timing, saved progress, virtual windows, image loading, and
navigation ownership that the reduced test does not model.

### 33. Treat Large Restored State as a Stress Test

Large restored state can expose real main-thread costs even when it is not the
root cause of a regression. A 1000-result search list, a 3000-chapter detail
view, or a large comments tree is useful evidence about broad reactive
invalidation, DOM cost, and gesture sensitivity.

Do not confuse the stressor with the owner of the bug. If a heavy search result
set is restored while favorites owns the route, the fix is restore ownership,
not hiding or hibernating views. Keep the stress case as performance evidence,
but fix the state owner that caused the wrong work to run.

### 34. Top-Level Views Stay Mounted Unless Behavior Explicitly Changes

The list, favorites, manga detail, reader, and comments surfaces are navigation
layers, not disposable route pages. They may be visually covered by a higher
layer and still need to preserve scroll, gesture continuity, and peek-back
behavior.

Do not add hibernation, parking, inert modes, or conditional mounting for a
top-level view as a performance fix unless the behavior change is explicitly
approved. If a covered view is doing expensive work, fix the owner that is
committing the work; do not make mount lifetime responsible for correctness.

### 35. Avoid Broad Svelte State Broadcasts

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

### 36. Gestures Own the Frame Budget While Active

During an active swipe or momentum scroll, gesture movement should be direct
DOM/CSS variable work. Other owners must avoid large `$state` commits, DOM
scans, image-start bursts, or result application that can compete with the
interaction.

`pauseBackgroundWork` and related foreground gates are about frontend commit
ownership. Backend work does not directly block the frontend main thread, but
frontend application of backend results can. Logs should distinguish queued,
deferred, resumed, skipped, and committed work so jank windows can be tied to
the owner that spent the frame budget.

### 37. Restore Only the Owning Surface

Search and favorites are sibling roots. Restoring favorites must not replay
search just because an older session contains search context. Restoring search
may replay search. Restoring manga or reader may replay search only when the
back stack says search/list owns the origin path.

Persisted search context is domain state for the search surface, not global app
state. A restore path must first identify the current surface and back stack,
then replay only the domain owners needed for that path.

### 38. Live Search, Live Comments, Cached Manga Data

Production data ownership is explicit:

- Search is live. The frontend calls the narrow backend `/api/search` endpoint.
- Comments are live/fresh, but not BrowserSession-owned. Manga-detail comments
  and reader chapter comments call backend comments endpoints with no-store
  semantics. `CommentsService` reads cached manga detail to get the numeric
  provider ID and page identifiers, then uses normal backend HTTP via
  `proxyFetchJson` for thread lookup, root comments, and tree fills.
- Manga detail metadata, chapter lists, and chapter images are cache-backed.
  The frontend reads those through `/api/cache/...` and does not restore the old
  live detail/chapter/image request paths.
- Favorites store only favorite identity locally. Display metadata and chapter
  stats hydrate from the backend cache.

The search endpoint is intentionally narrow. It is not a generic proxy. The
backend route owns transport, Cloudflare cookie/header handling, request
validation, and logging. The provider owns Comix search semantics: URL
construction via `searchRequest` and response shape via `parseSearchResponse`.
This prevents duplicating provider query parameters in the server while also
preventing the frontend from regaining a "fetch anything live" escape hatch.

### 39. Backend Cache Is the Manga Data Owner

The backend cache is the source of truth for manga details, chapter lists, and
chapter image metadata. Comix remains an ingestion source, not a frontend data
source for those domains.

Cache ownership:

- Backend owns SQLite persistence, invalidation, priority, and store-health
  policy.
- BrowserSession owns Comix runtime browser access for cache ingestion only.
- The provider owns Comix-specific paths, runtime HTTP capability discovery,
  and response normalization.
- `CommentsService` owns comment identifier lookup from cached manga metadata
  and fresh comment HTTP calls.
- Frontend owns user intent, cache priority requests, and image outcome
  observations. It does not know that BrowserSession exists.
- Image store candidate generation is a response-time backend projection, not
  durable cache data. Candidate ordering belongs to the backend cache/provider
  boundary, and observed frontend outcomes are reported back to the backend.

Serving ownership:

- Reader images use cached canonical page metadata plus generated direct store
  candidates. The backend orders those candidates from observed store latency;
  the frontend tries them directly and reports outcomes. Reader page bytes are
  not downloaded into the backend byte cache and no longer pass through
  `/api/image`.
- Manga covers are owned resources. Search crawl owns `card` covers from
  `poster.medium`; manga-detail caching owns `detail` covers from
  `poster.large`. `ByteCacheService` stores the bytes, but
  `manga_cover_cache` records the manga id, variant, source URL, local key,
  status, and error.
- There is no generic `/api/byte` route and no reader `/api/image` proxy.
  Comment avatars/content images are not cover-cache data.

Cache layers:

- Startup seeds the cache from newest 100 manga and queues those manga for
  detail and chapter-list caching.
- Chapter-list caching fetches complete lists and stores them durably.
- Chapter-image caching discovers complete canonical page URLs after chapter
  lists exist. Store candidates are generated when a chapter-image response is
  served, not persisted as cache rows.
- Frontend priority requests can promote foreground cache work ahead of queued
  lower-priority work. Long non-foreground chapter-list and reconcile jobs also
  yield at page boundaries when foreground work appears.

SQLite stores:

- `manga_cache`
- `chapter_list_cache`
- `chapter_image_cache`
- `image_store_status`
- `image_store_observations`

The cache worker has foreground, observed, daily, and background data jobs.
Power-off safety comes from durable job rows and atomic cache mutations:

- Job rows are durable intent. If the process dies, running jobs are recovered
  on restart and returned to the runnable queue.
- Chapter-list jobs fetch pages into memory and commit the complete list only
  after the job finishes. If they yield or the process dies before commit, the
  old cache remains unchanged.
- Chapter-image metadata writes are atomic canonical payload writes. Generated
  store candidates are not persisted, so power loss cannot leave a candidate
  expansion half-written.
- Cooperative yield is allowed only at safe boundaries between upstream page
  requests, before the final cache write.

### 40. Cache Readiness Is a Contract

A row existing in SQLite is not enough to serve it as ready. Cache consumers
need typed readiness contracts.

Chapter images are user-visible `ready` only when the backend has populated
every target page from Comix's runtime HTTP chapter detail path:

- `source=runtime-http`
- `targetCount > 0`
- `pages.length === targetCount`
- every page has a concrete image URL

Empty, partial, encrypted, or DOM-observed payloads are
diagnostic/incomplete states. They must not be served to the reader as loaded
chapter images. The frontend also refuses zero-page cache payloads so the
reader cannot hydrate an empty chapter as a successful load.

BrowserSession should not expose signed request details, minified export names,
or provider-specific runtime mechanics outside the provider/cache boundary.
The provider resolves the current runtime HTTP client by behavior; the cache
stores only normalized typed payloads.

For Comix specifically, chapter-list and chapter-image metadata are not normal
public HTTP resources. They require the current site runtime token/signing
context. That is why the cache ingests them through BrowserSession instead of
plain backend `fetch`. The durable cache boundary exists so the frontend never
has to know about this browser/runtime requirement.

Store candidates are expanded from real discovered image URLs by replacing only
known `wowpic*.store` hosts while preserving the image path. The backend owns
candidate order. The frontend reports image status, latency, and session id;
the backend updates latest per-image/per-store status in `image_store_status`
and appends durable latency evidence to `image_store_observations`.

Candidate selection is adaptive:

- Compute a store winner from recency-weighted observations with a 30-day
  half-life.
- Require at least 200 observations before a store can become the exploited
  winner. On 2026-05-13 this did not change the selected winner
  (`80pd.wowpic1.store`), but it prevents a low-sample lucky store from taking
  over normal reading.
- Score each store by weighted tail latency: p90 `0.25`, p95 `0.4`, and p98
  `0.35`; lower score wins. Do not include max latency in the score because it
  is too noisy for normal reader policy, while p98 still captures tail risk.
- Treat non-200 observations as a flow-level failure by assigning them a
  dynamic penalty near the average observed successful max latency.
- Serve the winner first 80% of the time, then randomize the remaining stores.
- Explore 20% of the time by randomizing the first store as well. This keeps
  learning alive instead of freezing on the first good host.
- Keep the fallback behavior: the frontend still tries candidates until one
  succeeds, so a bad first store is evidence for ranking rather than a page
  failure.
- Monitor whether the winner stabilizes and improves first-image latency. The
  80/20 split is a policy knob and should only be tightened after the logs show
  enough adaptive observations.
- Do not make the system fully random for long data collection. The normal
  reading path is the primary citizen, so the policy should keep serving the
  best observed winner while the 20% exploration path continues collecting
  evidence from the other stores. If future tuning needs better separation,
  tag image observation sessions by reader activity mode such as restore,
  slow-scroll, fast-scroll, momentum, and idle-preload.

### 41. Large Search Lists Still Need Optimization

A restored or deeply paginated search list can leave 1000+ manga cards mounted
behind manga details and reader. That state is valid and should not be hidden
by hibernating or unmounting the search surface, but it is a real main-thread
stress case.

On 2026-05-09, four card-mode stress tests were run with a restored search
context that loaded 1200 results before opening the reader:

- **Normal cards:** cover plus `read / filtered max / upstream max` badges with
  per-card progress and chapter-stat subscriptions. Reader frame gaps after
  opening from the heavy search state sustained around 100ms.
- **Dumb cards:** cover plus a simple upstream-max badge, with no per-card
  progress/chapter-stat subscriptions. Reader frame gaps sustained around
  67ms. This was the only proven win.
- **Image-window cards:** dumb cards with cover `src` only for the sampled
  visible list window. This did not improve the reader gaps and caused
  recommendation-list images to disappear because the experiment applied image
  ownership to lists that do not track visibility.
- **Windowed-stats cards:** normal-looking badges only for the sampled visible
  list window, with list-owned snapshots. This did not preserve the dumb-card
  win in the test and added complexity without proof.

The dumb-card model was not accepted as a production change because it removes
information from the card UI. The current product requirement remains the
three-number card overlay described in BS. The performance evidence is still
useful: it shows that card overlay/subscription work contributes to jank, but
the next optimization must preserve the existing UI.

Performance logs should remain available while optimizing this path. Useful
events are `reader-frame-gap`, `search-result`, and `restore-target-found`.
The old visible-list prewarm path was removed when backend cache data became
the owned source of chapter metadata.

Remaining search work: preserve the existing card UI while reducing the cost of
large search result sets. Likely directions include better ownership of
progress/stat data, reducing broad Svelte invalidations during search replay,
and investigating DOM/style/layout cost from 1000+ mounted cards. Do not change
the navigation behavior, hibernate top-level views, or remove card information
without explicit approval.

### 42. Separate Logical Position from Physical Scroll Surface

The reader can know about thousands of chapters without making the browser
scroll a document that is tens of millions of pixels tall. Logical manga
position and physical browser `scrollTop` are separate resources and must have
separate owners.

The winning reader architecture is:

- `ReaderWindowManager` owns logical chapter coordinates for the whole manga.
- `ReaderState` owns the bounded physical scroll runway and maps between
  logical manga coordinates and browser `scrollTop`.
- `Reader.svelte` owns DOM observation and calls back into the reader owner; it
  does not decide global layout policy.
- `ReaderMemoryManager` owns page image blob lifetime inside the mounted
  physical window.

The physical reader stage is a bounded runway around the current logical
viewport, currently about 200k px above and 200k px below the viewport. When a
full manga detail has 3000+ chapters, the logical scroll position may be around
26M px, but Safari should only see a physical scroll surface around 250k-400k
px. Logs must show both numbers (`logicalScrollTop`, `physicalWindowStart`,
`physicalHeight`, `scrollHeight`) so regressions are easy to spot.

Failed approaches from the 2026-05-08/09 reader performance work:

- **DOM/layer hibernation:** unmounting hidden top-level views changed behavior
  and did not address the reader's real ownership problem. Top-level views stay
  mounted unless behavior explicitly changes (see rule 34).
- **Image placeholder A/B:** replacing reader images with placeholders only
  proved that images were absent; it did not model the real reading path and
  was not useful as a production-facing experiment.
- **Giant virtual spacer:** mounting only nearby chapters while keeping the
  physical scroll height equal to the full logical manga height made iOS Safari
  manage a 26M px scroller. Reader JS stayed cheap, but scroll/compositing
  felt heavy.
- **Frozen placeholder heights:** preserving a placeholder's reserved height
  forever avoided immediate scroll jumps but caused cropped/overlapping
  chapters when hydration proved the real chapter was taller.

The durable fix is the bounded physical scroller: keep full logical knowledge,
load/fetch chapters by logical proximity, but cap the browser scroll surface and
rebase the physical runway around the visible logical position.

## Product Decisions

These are app-level behavior decisions that drive UX, persistence, navigation,
loading, and recovery behavior.

## AA. NSFW Genres Auto-Excluded on First Install

When a provider is used for the first time (no prior filter state for that provider), the app auto-excludes all genres that the provider marks as NSFW. The app does not know which genres are NSFW by name — it asks the provider which genres are NSFW and excludes them. After this one-time seeding, the user can toggle any of them freely. If the provider already has saved filters, this seeding is skipped entirely. This triggers independently per provider — installing a second provider seeds its NSFW genres even if the first provider's filters already exist.

## AB. Genre Filters Are 3-State Toggles

Each genre filter cycles through three states on tap: empty (no filter) → include → exclude → back to empty. This applies to all genre terms, including the NSFW ones seeded in rule AA. Types and statuses are simpler binary toggles (on/off). Long-press is not used on filter chips — it is reserved for the chapter list's group items, where it shows a block/cancel option to add the group to the provider-wide blacklist (see AF).

## AC. Filter and Search Interaction

All search inputs — filter toggles (genre, type, status) and text input — go through the same 500ms debounce. Every change (keystroke, filter toggle) restarts the debounce and aborts any in-flight search request. After 500ms of no changes, a new search fires from page 1 with the current text + current filters combined, replacing the entire result set. Any in-flight pagination (rule AD) is implicitly abandoned because the results are replaced. Pressing enter skips the debounce and fires immediately.

The fetch is always non-blocking — the UI stays responsive while results load.
The user can freely mix toggling filters and typing without the UI freezing or
results resetting mid-edit. Filters and query persist to localStorage for the
current Comix-focused app.

## AD. Search Pagination with Deduplication

Search results are paginated from the upstream provider. Each page append deduplicates by manga ID to prevent duplicates across pages. The app relies on the provider's `hasMore` flag to know when to stop — it never hardcodes a page size threshold itself. The provider returns `hasMore` with each page of results; the app uses it as-is.

## AE. Infinite Scroll Trigger Zone

The infinite scroll sentinel fires 5 viewports before the user reaches the bottom of the list (rootMargin: 500% 0px). This aggressive prefetch means the user almost never sees a loading state during normal scrolling — new pages load well before they're visible.

## AS. Manga Cards Are Cover-First

Manga cards prioritize the cover image — no title, no author, no badges, no padding between cards. The only overlay is compact chapter-progress metadata at the bottom of the card (see BS). This is a deliberate deviation from standard manga apps (Tachiyomi, MangaDex) which show title text and metadata below each card. The tradeoff: less information per card, but more covers visible at once and faster visual scanning. The user identifies manga by cover art, not by reading titles.

## BS. Manga Cards Show Read, Filtered Max, and Upstream Max

Manga cards show three chapter numbers as `read / filtered max / upstream max`.

- **Read:** The latest locally saved reading progress for this manga. If the manga has no saved progress, this is `0` on a red badge. If it has saved progress, the badge is green.
- **Filtered max:** The highest chapter number known after applying the current group filters. This comes from the backend-cached chapter list, then the frontend applies local provider-wide and per-manga group filters.
- **Upstream max:** The max/latest chapter number returned by the provider's search/list API.

Favorites store favorite IDs plus the minimum card snapshot needed to render
instantly when the favorites root is opened. The backend cache remains the
authoritative source for chapter stats and full manga data; favorite snapshots
are only a local card-start cache and can be refreshed from backend cache data.
There is no card-owned chapter prewarm path. Search results still provide
their upstream max directly from live search. Opening a manga remains the
authoritative foreground path for displaying the full cached detail and chapter
list. Card cover bytes are separately owned by the backend cover cache.

## AF. Chapter Group Filtering

Chapter filtering is a single pipeline: raw chapters in, filtered/deduped/sorted chapters out. The pipeline takes three inputs — the raw chapter list, the provider-wide blacklist, and the per-manga group selection — and produces one output. The stages are:

1. **Blacklist filter:** Remove chapters whose group is in the provider-wide blacklist (hide this scanlation group's chapters across all manga for the active provider — see BH). In the per-manga group selector, blacklisted groups appear grayed out but remain selectable.
2. **Per-manga group selection:** If the user has selected specific groups for this manga, keep only chapters from those groups. Selecting a blacklisted group overrides the blacklist for that manga only.
3. **Dedup by chapter number:** When multiple groups have the same chapter number, the latest upload wins.
4. **Sort descending:** Chapters are sorted by number, newest first.

Tests assert the pipeline's end state for each behavior.

## AG. Chapter Lists Come from Backend Cache

When opening a manga, the app reads the cached chapter list from the backend.
If the cache row is missing or warming, the backend owns the fetch and queue
priority, and the frontend polls the cache endpoint until the data is ready or
the request is aborted.

The frontend commits the cache result as one chapter-list snapshot, then owns
local deduplication, sorting, and group filtering for display. It does not
stream Comix chapter pages directly and it does not write thousands of
intermediate chapter-list states into Svelte.

Manga details have one frontend commit owner. Opening or restoring a manga
first peeks cached detail and cached chapters:

- if both are hot cache hits, manga metadata, recommendations, and the chapter
  list are committed together as one foreground snapshot
- if either cache row is warming, title/cover from the existing card remains
  visible while the loader commits detail metadata first, chapters second,
  recommendations third, and comments last
- if a later section is already ready when an earlier dependency resolves, the
  ready sections are batched into the same commit

This prevents cached manga-details from behaving like the old live mode, where
detail, recommendations, chapters, and comments raced each other and mounted
large sections in random order. Comments are still fresh live data and remain
the final background section.

## AH. Progress Is Tracked Per Manga

Reading progress stores chapterId, chapterNumber, pageIndex, and scrollOffset
(pixel offset within the current page), keyed by manga id in frontend IDB. This
means progress remembers which chapter you were on, which page, and exactly
where on that page — but only the latest position per manga, not per chapter.

## AI. Progress Synced with 500ms Debounce

Scroll-based progress updates are debounced at 500ms before writing to IndexedDB. This keeps progress close to the user's visible position without writing on every scroll event. Closing the reader flushes the latest tracked page immediately, so swipe-back does not wait for the debounce.

## AJ. Current Page Detected at 1/3 Down the Viewport

The visible page is determined by which page element sits at 1/3 of the viewport height from the top — not the center, not the top edge. This accounts for the natural reading position where your eyes focus below the top of the screen.

## BL. Reader Image Prefetch Margin

Reader page images are scheduled by the reader memory manager from current virtual geometry, not by per-chapter IntersectionObservers. On each reader render or scroll pass, mounted page elements inside a 14-viewport image window are prioritized by distance from the visible-page probe. Blob URLs outside that image window are revoked and removed from their image elements.

This image window is separate from the reader chapter window in AK and from list-view infinite scroll in AE. Chapter slots decide which chapters exist in the DOM; the memory manager decides which mounted page images should hold blob URLs.

Image cleanup is lease-like rather than observer-authoritative. A page leaving
the image window becomes a cleanup candidate; it is not immediately destructive
while scrolling or while a rebase/projection transaction is active. Cleanup is
allowed only when the reader is idle and the page is still outside the owned
window. This keeps image memory ownership from flashing visible pages black.

## AK. Reader Uses a Bounded Physical Scroller over Logical Chapter Windows

The reader lays out all chapters in one logical manga coordinate space, but the
browser never owns that full logical height. The physical DOM scroll surface is
a bounded runway around the current logical viewport. This lets the app know
about a full 3000+ chapter manga while keeping iOS Safari away from 20M+ pixel
scroll surfaces.

Ownership is split deliberately:

- `ReaderWindowManager` owns logical layout: chapter order, logical top/bottom,
  load-window candidates, DOM keep-window slots, and fetch priority.
- `ReaderState` owns physical layout: `physicalWindowStart`, physical
  `scrollTop`, physical stage height, and the mapping between logical and
  browser coordinates.
- `Reader.svelte` owns DOM observation, page measurement, and scroll events.
  It reports facts to `ReaderState`; it does not decide global reader layout.
- `ReaderMemoryManager` owns image blob lifetime for mounted pages in the
  physical window.

Window policy:

- **Physical runway:** reserve about 200k px above and 200k px below the
  viewport. `ReaderState` may rebase `physicalWindowStart` only when an
  explicit lifecycle owner supplies a physical target, such as initial open or
  restore. Live scroll observations may request soft window work, but they may
  not authorize a hard physical projection write.
- **Load window:** chapters whose logical slot intersects 10 viewports before
  or after the logical viewport are wanted. Wanted placeholder slots are fetched
  by priority.
- **DOM keep window:** slots are kept mounted while they intersect 12 viewports
  before or after the logical viewport, or while they are wanted by the load
  window.
- **Image window:** mounted page images are loaded and retained within the
  14-viewport image window described in BL.
- **Cache warm window:** chapter image metadata is warmed for every chapter
  whose logical slot intersects the full bounded physical runway. This is
  larger than the render/load window on purpose: the reader owns what can
  become visible inside its physical scroll surface, so it may send foreground
  cache intent for those page maps before the DOM needs to mount them.

Priority is recalculated from the current logical viewport. Distance to the
viewport is the base priority; the current scroll direction biases work toward
previous chapters while scrolling up and next chapters while scrolling down.
Nearby placeholder slots are fetched concurrently up to the current scheduler
limit.

Do not express reader prewarm as fixed counts such as "two previous chapters"
or "four next chapters." Chapter heights vary too much for count-based warming
to match the bounded physical scroller. The durable ownership model is
geometry-driven: `ReaderWindowManager` computes which chapter slots intersect
the physical runway, `ReaderState` dedupes already-ready/in-flight/requested
chapters, and the backend cache scheduler owns durable queueing and promotion
through a foreground `reader-window` warm batch.

Logical scroll position is the cursor owner. The window planner receives an
already-owned `logicalScrollTop`; it must not derive logical position from a
new `physicalWindowStart` plus an old DOM `scrollTop`. Physical scroll is only
a projection of the logical cursor into the bounded runway. During a rebase,
`ReaderState` computes the logical position from the old projection, chooses
the new physical runway start, then writes the new physical `scrollTop` as
`logicalScrollTop - physicalWindowStart`.

The physical projection is versioned. `ReaderState` owns a projection epoch
that advances whenever the physical runway start changes. `Reader.svelte` owns
the DOM-applied projection epoch and includes it with every scroll observation.
A DOM scroll observation from an older projection cannot become authoritative
cursor input after a rebase; it is logged as
`reader-stale-physical-observation` and the current projection is reapplied.
This closes the cross-event race where Safari can deliver a scroll value from
the old runway after state has already committed the new runway.

There is one exception to "physical runway start changes advance the epoch":
anchor-preserving layout projection. When late chapter metadata changes the
height of a chapter above the current reader owner, hydration must not write
`scrollTop` to compensate. Instead, `ReaderState` shifts
`physicalWindowStart` by the same layout delta and repositions slots so the
browser's existing physical `scrollTop` still points at the same visible
content. This is a layout projection, not a DOM scroll projection, so it does
not advance the DOM-applied projection epoch and it must log
`reader-window-anchor-projection`, not `reader-scroll-write`.

The owning rule is:

- Initial restore and explicit physical rebase may write DOM `scrollTop`.
- Hydration and measurement may make better height data available.
- If that height data is above the current anchor, `ReaderState` owns the
  coordinate remap inside the virtual window.
- `Reader.svelte` must not apply a delayed `scrollTop += delta` anchor
  compensation during normal reading.

This exists because a 2026-05-31 bug showed a previous-chapter hydration above
the current reader owner growing from about `56183` to `67092` px. The old path
queued `window-anchor-adjust` and wrote DOM `scrollTop` by about `10909` px
while the user was reading chapter 62, causing an apparent jump. The corrected
model keeps scroll ownership with the DOM and moves only the reader's logical
projection.

Destructive physical projection is also transactional and session-owned.
Timer-derived labels such as "idle" or "settled" are not proof that Safari/iOS
has finished scroll momentum or accepted a programmatic `scrollTop` write. RAF
velocity samples are also only observations; slow inertial scrolling can look
stable for a few frames and then continue. Native reader `scrollend` is the
rebase authority. RAF stability may be logged for diagnostics, but it must not
authorize a destructive rebase. When the reader element emits native
`scrollend`, the scroll-session owner starts a 100ms quiet grant. Any new
scroll, touch/pointer activity, swipe, or projection transaction cancels the
grant and the session must wait for a new native `scrollend`.

The 100ms quiet grant is an explicit user-chosen UX policy after phone testing,
not a hidden implementation timeout. The architecture decision is that native
`scrollend` owns the permission boundary; the 100ms delay is the user's chosen
small cushion before executing the owned projection. If future testing changes
that number, document it as a product/UX decision, not as a generic timer hack.

Once authorized, a rebase creates an explicit projection transaction:

- `ReaderState` computes and commits the new owned projection.
- `Reader.svelte` writes the derived physical `scrollTop`.
- scroll observations are ignored for planning while the transaction is active.
- a RAF acknowledgment checks that the DOM still reports the target physical
  scroll position.
- if the DOM reports a different physical position, the transaction reapplies
  the target and logs `reader-projection-transaction` with `phase=reapply`.
- only after `phase=ack` may normal scroll observations drive planning,
  cleanup, or layout promotion again.

Timers may still schedule work elsewhere in the app, but a timer alone must not
grant permission for destructive reader operations. The only timer allowed in
reader projection is the post-stability quiet grant owned by the scroll-session
owner. Reader layout promotion is scheduled by frame and is blocked by active
projection transactions, not by a guessed settled state.

If a live scroll approaches the bounded runway edge before the scroll-session
owner grants idle authority, the reader logs `reader-rebase-deferred` and keeps
the existing physical projection. This may surface a runway-size or
edge-pressure problem, but it does not let Safari's ongoing momentum turn an
old physical coordinate into a new logical chapter. The ownership rule is
intentionally browser-independent: browser scroll events can describe motion,
but only the reader lifecycle owner or the scroll-session owner can write a new
physical projection.

This rule exists because a bug on 2026-05-10 showed the failure mode clearly:
the DOM scroll moved only about 700px, but the planner recomputed logical
position after rebasing the runway and jumped about 121k px into the next
chapter. The reader then mounted only a placeholder chapter, `ReaderMemoryManager`
revoked the old blob URLs because the new geometry had zero pages, and the user
saw a black screen. The fix was to make logical position the owned cursor and
physical position a derived projection.

A related 2026-05-11 bug showed the same ownership leak across event turns:
after chapter 73 rebased the physical runway, a later stale DOM scroll
observation from the old runway was combined with the new
`physicalWindowStart`, making the planner select chapter 76 and drop chapter
73. The projection epoch rule is the durable fix for that class of stale
physical observations.

A later 2026-05-11 bug showed that projection epochs alone were not enough:
the old `scroll-settled` timer declared the reader settled after three stable
samples, performed a destructive rebase from about `322179` to `200000`, and
then browser scroll behavior continued at the old physical coordinate. The
planner accepted that coordinate in the new projection and jumped from chapter
80 to chapter 83. This is why physical rebases now require transaction
acknowledgment instead of timer-based settle guesses.

Another 2026-05-11 regression showed that a RAF motion lease was the same
class of bug in a different form. The reader deferred a bottom-edge rebase
while Safari was still scrolling, decided after several small deltas that
motion was stable, wrote `scrollTop` from about `320325` to `200000`, then
accepted Safari's continued `320341` observation in the new projection and
jumped from chapter `7523941` to `7523953`. The durable fix is stricter than a
better motion detector: scroll-origin reconciles do not directly request
destructive physical rebases. They can only start a scroll session. The
scroll-session owner must wait for native reader `scrollend`, then ask
`ReaderState` for an edge-pressure rebase target after the 100ms quiet grant.

Earlier tests used a 1000ms post-stability grant because a 2026-05-11 edge test
showed Safari emitting late scroll events after RAF stability at roughly 64ms,
88ms, 116ms, 252ms, 283ms, and 368ms. A follow-up test showed native reader
`scrollend` firing after those late scrolls, and two real edge rebases completed
smoothly with `quietMs=100`, `reason=native-scrollend`, and projection
acknowledgments with `delta=0`. The reader therefore removed the
`stable + 1000ms` fallback: keeping both authorities made the architecture
harder to reason about and left two possible owners for destructive projection.
If native `scrollend` is absent or wrong in a future environment, the logs
should surface that as a browser-support problem rather than silently falling
back to a timer-based rebase owner.

Placeholder slots are layout hints, not visible-page authority. If a wanted
placeholder is the current/probe candidate, fetch ownership must still start
the chapter image metadata request. The reader must not treat `side=current` as
a reason to skip fetching a non-ready slot. A chapter can become the visible
progress/title owner only when ready page geometry exists for it.

Ready chapter slot height is owned by page geometry. Placeholder/reserved height
may keep runway space while metadata is missing, but it must not survive as the
height of a ready chapter. A 2026-05-11 dead-space bug showed why: chapter 87
hydrated from a 48,809px placeholder to 34,479px of real pages, but the render
slot kept the old `virtualHeight`; the viewport could then sit inside the
chapter section with `visiblePages=0` and `visibleImages=0`. The durable rule is
that `virtualHeight` is a reservation for non-ready slots, while ready slots use
real estimated/measured page height. Destructive physical rebases must not be
used as accidental stale-height cleanup.

Committed render-frame geometry is separate from planner/cache geometry.
`ReaderWindowManager` may plan with placeholder and cached chapter data, but
visibility, page tracking, image scheduling, and progress must read from the
mounted render projection owned by `ReaderState` and `ReaderMemoryManager`.
Planner data can request work; it cannot become a visible-page fact.

When a chapter hydrates and its real height differs from the placeholder,
logical layout may change. The physical runway absorbs that change by keeping
the visible anchor stable inside the bounded surface. Hydration must not crop a
chapter by freezing the old slot height forever, and it must not expand the
browser's physical scroll surface to the full manga height.

## BM. Chapter Loading Priority and Boundaries

When opening a chapter, the selected chapter loads first and is placed into the
logical reader layout. The reader then maps the restored or initial logical
position into the bounded physical runway from AK and fetches nearby
placeholder chapters according to logical proximity. Fresh opens, restores,
fast upward scrolls, and fast downward scrolls all use the same
virtual-window planner.

The same planner also warms chapter image metadata for the full physical
runway. This is not old card/detail prewarm. It is reader-owned cache intent:
if a chapter can enter the bounded runway without another physical rebase, its
page map should be in the reader's local `chapterDataById` before slow
scrolling reaches it. The frontend does not prove readiness by firing a
backend-only warm request. `ReaderState` owns physical-window metadata
hydration, starts bounded background `fetchChapterImages` work for the nearest
physical-window candidates, stores successful page maps in `chapterDataById`,
and lets render-window promotion consume that local state.

The 2026-05-14 verification showed why this boundary matters. The first
attempt warmed backend cache rows for 9 nearby chapters and the backend logged
`discovered=9 queued=4 ready=5`, but the reader later still emitted
`reader-window-fetch-failed` timeouts for chapters that had been cached minutes
earlier. That proved the wrong owner was being verified: backend cache
readiness was necessary, but not sufficient for a smooth reader. The durable
success signal is now `reader-window-hydrate-ok` before a chapter becomes
visible, followed by `reader-window-local-hit` when render-window promotion can
use local reader state without a new foreground cache read.

Offscreen metadata hydration is not allowed to own layout. It can store page
maps in `chapterDataById`, but it must not invalidate the physical-window
planner, update layout height authority, or trigger anchor compensation until
the chapter is actually promoted into the render window. Likewise, visible
chapter ownership comes from the viewport probe point; previous layout/current
owners are only fallback/tie-breaker context. A stale owner that is still
partly visible must not pull `currentChapterId` or progress back across a
chapter boundary.

This does not mean every image byte in the 200k px runway is already loaded.
Chapter page-map metadata and reader image bytes have different owners. The
reader metadata hydration prevents missing chapter metadata from blocking slow
scrolling into the next chapter. `ReaderMemoryManager` still owns image
byte/blob scheduling inside the image window described in BL, and occasional
single-image loading is
ordinary byte catch-up rather than a page-map/cache miss.

Chapter change is detected from the visible page probe at one-third down the
viewport (see AJ). `currentChapterId` is the live visible/progress owner;
`layoutChapterId` is the initial/restored chapter anchor and must not override
the live visible chapter in frame logs or hydration ownership once reading has
moved. Visibility is an observation; it can update progress and title context,
but it does not own virtual layout.

A visual divider separates chapters in the reader.

## BP. Image Fetch Failure Recovery

Image fetch failures are handled differently based on the error:

- **Image blob fetch failure:** The failure is logged with `img-fail`, the image is left without a blob URL, and it does not block adjacent chapter loading.
- **Retry path:** Because image loading is geometry-driven, a later render or scroll pass can attempt the image again if the page is still inside the image window and no blob URL or in-flight load exists for that page.
- **Slow connection detection:** If 3+ image fetches fail within 10 seconds, show a one-time "Slow connection — images may not load" toast per session.

## BQ. Reader Images Rely on Direct Store and Browser Cache

Reader image bytes are fetched from direct CDN store candidates. When the
reader closes, blob URLs are revoked and memory is freed. Reopening the same
chapter can still benefit from browser HTTP cache when the adaptive winner
stays stable. Candidate order is now backend-owned: 80% winner-first for cache
locality and 20% exploration so weaker or newly faster stores can still surface.

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

Toggling a favorite updates the UI immediately before the IDB write completes.
If opening the database throws before the write can be attempted, the UI
reverts and shows a toast. Transaction-level write failures are logged through
the DB logger and do not block the foreground interaction.

## BR. Favorites Are Ordered by Insertion Order

Favorites appear in the order they were added (oldest first, newest at bottom). For session restore, the scroll target is whichever manga card was at the middle of the viewport when the user left the favorites view.

## AN. IDB Error Handling

IDB operations follow these rules:

- **Reads** (progress lookups, favorites listing): resolve with empty data so the app can still function, but show a one-time toast per session so the user knows their data didn't load.
- **Writes** (saving progress, adding/removing favorites): callers apply the
  user-facing state immediately and the DB layer logs write failures through
  `db-error`. Open/init failures still surface to callers; transaction failures
  should not crash reading or navigation.
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
- `viewMode=manga`, `viewStack=[favorites, manga]` — nested manga details opened from recommendations
- `viewMode=reader`, `viewStack=[favorites, manga, manga]` — reader opened from nested manga details
- `viewMode=chapter-comments`, `viewStack=[..., manga, reader]` — comments opened from the reader path

Back (swipe or button) pops one level from `viewStack`. Peek-back uses the same
stack, so the covered surface must remain mounted and visually stable during a
gesture. Session restore may rebuild stacks for the target surface, but it must
not invent a search owner behind favorites.

## AP. Session Snapshot Saves Navigation and the Owning Search Context

The session snapshot is a single object in localStorage with these fields:
`viewMode`, `viewStack`, `activeManga`, `mangaStack`, `targetMangaId`, and
`searchContext`. For manga-detail scroll restoration it also stores
`mangaScrolls`, an array of `{ mangaId, stackIndex, scrollTop }`, plus the
legacy single `mangaScroll` field for old snapshots.

View transitions save immediately. Visible manga tracking is debounced and
updates `targetMangaId`, which points to the origin manga for restore or
back-stack recovery. `mangaStack` stores nested manga-detail history directly
instead of reconstructing it from DOM state.

`mangaScrolls` stores scroll by layer. The key is both `stackIndex` and
`mangaId`, because a nested recommendations path can have several independent
manga-detail layers alive at once. Restoring only the active layer is
incorrect: each backing layer must restore its own scroll before it is revealed
by swipe-back.

`searchContext` is saved only when search/list owns the current path:
`viewMode === list` or `viewStack` contains `list`. Favorites does not own
search context. Restoring favorites must not replay a stale 1000-result search
behind it.

## AQ. Session Restore Is Automatic and Abortable

On app launch, if a session snapshot exists, the app restores it automatically.
The restore owner first recreates the saved foreground shell: `viewMode`,
`viewStack`, manga stack entries, and any overlay/reader surface implied by the
snapshot. This foreground shell is applied before favorites, search replay,
manga hydration, reader image metadata, or comments can make a different layer
visible. Hydration then runs behind that shell. This keeps app launch
responsive and prevents the root list/favorites surface from staying visible
until manga, reader, comments, or search replay finishes.

Restore also owns which layers are mounted. On cold start it mounts only the
saved foreground surface first. After that foreground owner has restored enough
state to be the visible surface, it mounts the backing stack in reverse visual
order so swipe-back has real layers behind it. Search and favorites remain
exclusive roots: a favorites-root restore must not mount or hydrate a stale
search root, and a search-root restore must not mount favorites.

Restore is silent during normal cold start. If the user takes any action during
restore (scrolls, taps a manga, changes view, or starts a new search), the
restore is cancelled silently — user action always wins. Each phase is
independently abortable.

The foreground shell can be applied from the local session snapshot before the
provider is ready. Data hydration still requires the active provider to be
loaded first (see BI). Each sequence restores only the owners implied by
`viewMode` and `viewStack`:

**Search/list restore:**
- Replay the saved search context, or run the current empty/default search.
- If `targetMangaId` exists, paginate until the target is found and scroll to it.

**Favorites restore:**
- Set `viewMode=favorites` with an empty back stack.
- Load favorites from IDB.
- Do not replay search. Favorites is a root surface, not a child of search.

**Manga restore:**
- Set the saved foreground manga shell first with the saved back stack.
- Restore `activeManga`, `mangaStack`, group selection, and chapters per AG in
  the manga owner.
- Apply every matching `mangaScrolls` entry when its layer has enough height.
  If a layer is not tall enough yet, it keeps a pending restore target until
  hydration makes that scroll position reachable. User scroll aborts only that
  layer's pending scroll.
- Replay search in the background only if the back stack contains `list`.

**Reader or chapter-comments restore:**
- Set the saved reader or comments foreground shell first. If comments were
  saved, comments is the foreground surface and reader/manga/root are restored
  behind it.
- Restore all manga detail layers for the reader path so nested manga
  swipe-back surfaces are preserved.
- Prime reader layout from the actual restored viewport before applying reader
  progress, then restore reader position from IDB progress (see AR).
- Replay search in the background only if the rebuilt stack contains `list`.
- If the snapshot was comments, open comments after reader restore.

User action still cancels restore. Search replay and pagination are abortable,
and foreground reader work takes priority over background restore work.

Search restore may call the live `/api/search` endpoint. Manga-detail and
reader restore still use cached detail, chapter-list, and chapter-image paths.
Provider filter loading is search-owned. It may run before an initial search,
but it must not block restoring reader, comments, manga detail, or favorites.

## AR. IDB Progress Is the Source of Truth for Reader Position

When restoring a reader session, the app reads the reader position from IDB
progress — not from the session snapshot. The session snapshot records
navigation, active manga, manga stack, and manga-detail scroll layers. The
actual reader chapter, page index, and pixel offset come from IDB progress,
which is updated on a 500ms debounce and flushed on reader close.

Before applying the saved reader page offset, the reader primes virtual layout
with the actual restored viewport width and height. This prevents restore math
from using a stale/default viewport estimate and then correcting after the
first render, which would look like a restore jump.

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

When any backend request marked `cloudflareProtected: true` receives a
Cloudflare block, the backend proxy utilities own cookie/header reuse and
challenge-solving coordination. The provider declares which requests are
Cloudflare-protected; the backend owns transport. Search and cache ingestion
use this path, while manga details/chapter lists/chapter images reach the
frontend only through cache endpoints.

The app stays responsive while backend work is blocked or retried. Each
frontend caller is responsible for retrying only if still relevant: search
fires with the current query + filters, cached manga reads continue polling
while the user still wants that resource, and abandoned views abort their
requests.

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

Frontend JSON requests currently use a fixed default timeout of 12 seconds
through the shared `fetchJson` owner. Comment requests currently use a longer
45-second timeout because deep comment trees can require several upstream
calls. These values are implementation policy, not user-chosen UX decisions
like the reader `scrollend + 100ms` grant. Retry behavior is explicit per
caller via the `retry` option; retries are not hidden in feature code.

This is separate from the loading watchdog (rule AX), which catches stuck UI
state, not slow requests. Backend proxy/runtime requests have their own
transport-level timeouts because they own different resources.

## BB. Initial Failures Show Persistent Error State, Pagination Failures Show Toast

When the initial search or manga open fails, the app shows a persistent error state with the error kind (timeout / network / upstream) and an explicit "Tap to retry" button. The error stays on screen until the user acts — no disappearing toast for an empty screen. When pagination fails (results already on screen), a transient toast is appropriate since the user already has content to work with.

## BC. Chapter Image Fetch Retries Once Automatically

When loading chapter images, transient errors (408, 429, 5xx, network, timeout) trigger one automatic retry after a 1-second delay. If the retry also fails, the error propagates and the reader shows the persistent error state with retry.

## BD. Provider Unreachable at Boot

If the very first search on cold start fails (no cached results, no session to
fall back to), the app shows a persistent error state with the error kind and a
"Tap to retry" button — same as rule BB. The app does not crash or show a blank
screen. If loading the Comix provider bundle fails, the app shows a
provider/load failure with retry. The app requires a network connection for
live search/comments and for cache misses/warming — there is no full offline
mode.

## BE. IDB Storage Is Bounded by Design

The app's frontend IDB stores are designed to stay small without cleanup or
pruning:

- **progress** — one small entry per manga ever read, keyed by manga id.
- **favorites** — user-managed favorite rows with manga id plus the card
  snapshot needed for instant favorite-list rendering.

Search context, filters, group selections, and session state live in
localStorage. Large manga data, chapter lists, image page maps, thumbnails, and
byte-cache files belong to the backend SQLite/filesystem cache, not frontend
IDB.

No reader page images are stored in IDB. The reader uses in-memory blob URLs
that are revoked on cleanup. Direct CDN store requests and browser HTTP cache
handle refetch efficiency.

## BF. First Launch Shows Empty State

The current app is a Comix-focused PWA, not a multi-repository provider
installer. On first launch it initializes the bundled/dynamic Comix provider
and searches/restores from that provider. If provider loading fails, the app
shows the provider/load failure state and retry path rather than pushing a
repository-management flow.

## BG. Repository and Provider Management

Repository/provider installation UI is not part of the current product. The
extension build still produces a provider manifest and the frontend can load
the built Comix provider dynamically from `/providers/index.json`, but there is
no user-facing repository list, provider install/uninstall flow, or provider
switching state machine. Do not reintroduce a repo-management surface as part
of cache/search/restore work unless the product direction changes explicitly.

Provider builds are self-describing. The extension build imports each built
provider bundle to read its metadata, writes the provider manifest, and copies
the bundle into the app's bundled fallback directory. That fallback exists so
the Comix-focused app can still boot if the dynamic manifest path fails.

## BH. Data Isolation Per Provider

The app currently has one active provider domain: Comix. Client persistence is
still shaped so provider scoping can be reintroduced later, but the current
runtime does not switch providers and the session snapshot does not contain an
`activeProviderKey`.

Current persistent domains:

- **IDB progress** — one latest reader position per manga.
- **IDB favorites** — favorite manga identities and card snapshots needed for
  instant favorite-list rendering.
- **localStorage filters** — current Comix search/filter state.
- **localStorage group blacklist and per-manga group selection** — local group
  filtering policy.
- **Session snapshot** — current view/back stack, active/nested manga context,
  owning search context, and per-layer manga scroll snapshots (see AP).

Backend SQLite cache data is provider-owned by the server-side Comix provider
and uses Comix manga/chapter identifiers as cache keys.

## BI. Provider Loading at Boot

On cold start, the app initializes the Comix provider before search, restore,
manga-detail reads, reader image reads, or comments. The
frontend first tries the built provider manifest from `/providers/index.json`;
if that dynamic load fails, it falls back to the bundled Comix provider shipped
with the app. Provider filters are fetched through the backend
`/api/provider-filters/comix` route and fall back to the provider bundle's
static filter definitions if the backend route fails. Provider filters are a
search capability, not a global boot prerequisite; they should be fetched
before running a root search and otherwise loaded in the background after the
saved foreground surface has been restored.

The dynamic provider import is intentionally runtime-resolved from the manifest
URL. Vite cannot statically analyze `/providers/${bundle}` imports, so the
frontend keeps the explicit Vite ignore directive there. This is not a
type-check escape hatch; removing it only produces Vite's variable bare import
warning while preserving the same runtime behavior.

## BJ. Live Network Paths Are Narrow Backend Endpoints

The app no longer exposes a generic frontend-controlled server proxy. Live
network operations are narrow backend endpoints with explicit ownership:

- `/api/search` for live search
- comments endpoints for live comments
- cache endpoints for cached manga detail, chapter lists, chapter images, cover
  bytes, and image-store observations

For search, the backend route delegates request construction and response
parsing to the provider bundle, then owns transport through `proxyFetchJson`.
Cloudflare cookie caching and solving remain keyed by upstream domain, not by
feature.

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

## D6. Chapter Image Metadata Comes from Runtime HTTP

Reader chapter image metadata is not parsed from rendered DOM scripts. The
backend asks the provider-resolved Comix runtime HTTP client for
`/chapters/{chapterId}` and normalizes `pages.baseUrl + pages.items[]` into
full page URLs and dimensions. DOM extraction is not a normal cache path and
must not be treated as a reader-ready source.

## D7. Cloudflare Cookie Domain Inheritance

Cloudflare sets cf_clearance on the parent domain (`.comix.to`), covering all subdomains. The cookie cache looks up by exact domain first, then tries the parent — so a request to `static.comix.to` finds cookies cached under `comix.to`.

## D8. Provider Bundles Served No-Cache

Provider JS bundles are served with `Cache-Control: no-cache` so updates take effect immediately without cache busting. Frontend immutable assets (content-hashed by Vite) are cached forever.

## D9. HTTPS Required for iOS PWA

iOS Safari requires HTTPS for PWA installation (Add to Home Screen). The server uses mkcert certificates. The manga-reader and gallery-reader backends crash without certs (no HTTP fallback).

The app also ships a minimal service worker for iOS 18 PWA installability. It
claims clients and has a no-op `fetch` listener, but it does not cache
requests and does not make the app offline-capable. Avoid adding service-worker
cache policy unless offline mode becomes an explicit product decision.

## D10. Server Runs Under xvfb-run

The manga-reader systemd service is wrapped in `xvfb-run` because Playwright/CloakBrowser needs a display for Cloudflare solving. Never kill the process directly or restart with nohup — always use `systemctl --user restart manga-reader`.

## D11. Reader Image Candidate Logs Are Frontend-Owned

There is no reader image proxy success path. Reader image loading tries direct
store candidates in the frontend, logs compact `reader-image-candidate` events,
and reports actual outcomes plus latency to `/api/cache/image-store`. Backend
persistence keeps latest `(image_url, store_url)` status rows and append-only
store-latency observations. Generated candidates are never stored just because
they could exist.

## D12. LogEvent Is a Discriminated Union

Every frontend log event is a variant of the `LogEvent` union type. Adding a new event requires adding it to the union first — the compiler forces every emitter to supply the correct payload. The `emit` function extracts the `event` field as the first arg and type-checks the payload against the event name.

Svelte component emitters should still be audited when new log points are
added. The union is the ownership contract for log payload shape; keeping it in
sync matters even when a build path does not surface a Svelte-side type issue
as loudly as a plain TypeScript file.

## D13. Image Load Outcomes Are Logged at the Attempt Owner

Reader image outcomes are logged by the frontend because the frontend owns
candidate selection and direct CDN attempts. Successful and failed candidate
attempts are reported to the backend as observations. `img-fail` remains the
page-level failure after all candidates fail.

## D14. There Is No App-Owned Signing Layer

The app no longer owns copied Comix signing logic, fixed minified export names,
or a signature-capture scheduler. When cache ingestion needs Comix manga
detail, chapter lists, recommendations, or chapter image metadata, the provider
resolves the current runtime HTTP client inside BrowserSession and calls that
client by capability.

Search remains a narrow backend route. Comments use `CommentsService` and
normal backend fetches. Frontend code must not regain a generic "fetch Comix
live" escape hatch or a signing API.

## D15. BrowserSession Owns Runtime Pages, Not Product Policy

BrowserSession owns the Playwright/CloakBrowser context and the reusable Comix
runtime HTTP page. It initializes the browser, lets the provider resolve the
runtime HTTP client, executes provider-owned runtime calls, and logs runtime
HTTP resets/failures.

CacheService owns what work should run, priority, durability, retries, and
which normalized payloads are ready to serve. The provider owns URL/path
semantics and normalization. BrowserSession should not decide cache policy,
comment behavior, frontend behavior, or product-level request routing.

## D16. Chapter Log Ownership: Manga Content Owner, Not API Layer

The `chapters-page` and `chapters-done` log events are emitted by the
foreground manga content owner, not by the cache API helpers. The API layer can
peek, poll, and parse cached payloads, but it does not know whether the caller
is opening manga details, restoring a backing layer, or preparing a reader
path.

MangaState owns the display context and therefore owns the logging and commit
phase: detail metadata, chapter list, recommendations, and comments. This keeps
logs aligned with the user-visible section commits instead of raw cache
transport.

## D17. Runtime HTTP Page Is Reused and Reset on Failure

BrowserSession keeps one reusable Comix runtime HTTP page for cache ingestion.
The page starts from a provider runtime page URL, stores the provider-resolved
HTTP client on `globalThis.__providerRuntimeHttp`, and serves manga detail,
recommendations, chapter lists, and chapter image metadata through
`page.evaluate()` calls into that client.

Because the browser uses a persistent profile, Chromium can restore old tabs
after a service restart. Those tabs are not product state; they are browser
resources that must be re-owned. BrowserSession adopts one startup page as the
runtime HTTP page and closes the remaining restored pages as orphans before it
creates the decoder. The invariant is that BrowserSession owns a bounded
browser surface: one warm runtime HTTP page for provider/cache API work plus
one warm decoder-owned page for scrambled image work. Cache work may keep
Chromium active, but it must not create an unbounded tab/process surface.
BrowserSession also emits lean browser-surface telemetry on startup and once per
minute: owned page count, Chromium profile process count, renderer count,
aggregate CPU, and RSS. This is evidence logging, not a CPU budget; the goal is
to surface tab/process ownership leaks in the service logs instead of relying on
manual `ps` audits after the machine is already hot.

If the runtime HTTP call fails, BrowserSession closes and recreates the runtime
page once, then retries the request. This keeps stale runtime state local to
BrowserSession instead of leaking fallback behavior into CacheService or the
frontend.

## D18. CloakBrowser CPU Mitigation Under Xvfb

The server still runs CloakBrowser under `xvfb-run`, but the app keeps browser
work narrow. BrowserSession launches CloakBrowser with GPU and GPU compositing
disabled, keeps one runtime HTTP page, and does not maintain a pool of
ephemeral signature-capture pages. Browser work should remain cache-ingestion
only; normal frontend rendering, comments, thumbnails, and image serving must
not route through BrowserSession.

## D19. No NavigationScheduler or Page Pool

The old NavigationScheduler/signature-capture architecture is gone. There is
no per-request page pool and no page-per-signature path. Cache ingestion uses
the reusable runtime HTTP page described in D17. If a future provider needs
navigation-heavy work, it must introduce an explicit owner and durability model
instead of reviving ad hoc page pools.

## D20. Chromium Spare Renderer Process Is Expected

After BrowserSession is initialized, Chromium may keep an idle spare renderer
process. This is not automatically a leak; Chromium's
`SpareRenderProcessHostManager` can keep one warm renderer so the next page is
cheap to create. Treat CPU activity, unbounded process growth, memory growth,
or restored persistent-profile tabs as evidence of a leak, not the mere
existence of one idle spare renderer.

## D21. Backend SQLite Cache Is the Durable Ingestion Owner

The backend cache service owns durable manga/chapter/page-map metadata
ingestion. Comix remains an upstream source, but normal cache population is
backend-owned: SQLite is the source of durable truth, BrowserSession owns
runtime browser access for provider-resolved runtime HTTP calls, and the
frontend only expresses user intent, reports stale observations, or reports
image-store observations.

The cache has durable data layers:

1. `manga_cache`: live search/newest manga rows discovered from Comix.
2. `chapter_list_cache`: full chapter lists by manga.
3. `chapter_image_cache`: canonical chapter page-map payloads for each
   discovered chapter.
4. `byte_cache`: local physical byte files for manga covers.
5. `manga_cover_cache`: the ownership index for cover bytes, keyed by
   `(manga_id, variant)` where variant is `card` or `detail`. Reader page image
   bytes remain direct frontend CDN fetches through generated store candidates.

`image_store_status` records latest frontend/backend observations for each
image/store pair: status code, ok/not-ok, source, and last check time.
`image_store_observations` records the durable latency stream used by adaptive
store ranking: image URL, store URL, host, status, ok/not-ok, source, total
milliseconds, optional frontend session id, and observation time. The frontend
reports observations; it does not own ranking or cache invalidation policy.

Work order is owned by the durable `cache_jobs` scheduler, not by in-memory
arrays. Jobs are deduped by `(kind, resource_key)`, claimed with leases,
retried through SQLite, and recovered after process death. Priority values are
resource policy, not labels:

- `foreground` for explicit user intent, such as opening a manga/chapter
- `observed` for user-adjacent stale observations, such as search seeing a
  newer max chapter than the cache has
- `daily` for newest crawl and cover-byte discovery
- `background` for detail, chapter-list, and chapter page-map completion

Foreground and observed work outrank daily crawl work; daily crawl work outranks
background completion. Long non-foreground chapter-list and reconcile jobs
cooperatively yield at page boundaries when foreground work is pending. A
single upstream request still finishes; arbitrary provider requests are not
hard-aborted. Yielding happens before the final cache write, so the cache stays
power-off robust while user-visible work gets the next safe ownership turn.

Power-off robustness is row-based. Completed cache rows are idempotent durable
facts and queued work is durable intent. On startup, the service recovers
stale `running` leases for both the data cache worker and the byte cache
worker. If power dies mid chapter-list job, no partial chapter-list row is
committed and the durable job is reclaimed. If power dies mid page-map job, the
canonical page-map payload is written atomically, so startup either sees the
completed row and skips it or reclaims the job.

Corrupt cache rows are not fatal during rebuild/discovery passes. If a cached
manga row or saved search page snapshot cannot be parsed while rebuilding cover
ownership, that row is skipped and the owning data job is expected to refresh
it. Cache repair belongs to the cache worker, not to a broad startup crash.

The cache layers discover their own lower-layer work. Search crawl rows enqueue
owned `card` cover byte jobs from `poster.medium` only. Manga-detail caching
enqueues owned `detail` cover byte jobs from `poster.large`. The cover cache is
field-specific; it must not recursively scan arbitrary payloads for image-like
URLs. When a chapter list is cached or reconciled, the backend enqueues missing
`cache-chapter-page-map` jobs for those chapters. The frontend can promote a
specific page-map job by opening a reader chapter, but it is not responsible
for ordinary page-map discovery.

Daily search crawl uses `crawl-search-page:{crawlDate}:{page}` jobs with a
cache-day key that rolls over at local `04:45`, not at midnight. The rollover
matches the app's practical usage window: late-night reading before 04:45 still
belongs to the previous cache day. CacheService owns a rollover timer as well
as startup recovery: at startup and at each 04:45 boundary it runs the same
durable crawl-start path. If the current cache-day crawl has no active
frontier, older unfinished search-page crawl jobs are demoted to background
priority and the current cache day's newest page runs first. Duplicate
resources are promoted/refreshed, not duplicated.

The byte cache is a separate engine, but it no longer exposes a generic URL
proxy. The public route is cover-owned:
`/api/cache/manga/:mangaId/cover/:variant`. On a ready owner row it streams the
local file. On a foreground request with a source URL it can proxy-and-store
that source while atomically updating both `byte_cache` and
`manga_cover_cache`.

Byte-cache failures are observations, not permanent truth. A fetch timeout or
transient upstream failure writes the owned cover row as failed and the durable
job retries up to its attempt budget. Later discovery of the same owned cover
can requeue the failed durable job after a cooldown; foreground cover requests
requeue immediately. A successful later fetch overwrites the failed row with
`ready` and clears the error.

The one-time cover-ownership rebuild attached existing `byte_cache` rows to
`manga_cover_cache` by scanning cached manga/search payloads, then purged
unowned byte rows. This removed comment avatars, comment images, and other
non-cover bytes from the cover cache. A DB meta marker prevents repeating the
expensive backfill on every restart.

The provider/BrowserSession boundary is the runtime normalizer. The provider
does not rely on a fixed minified export key or copied signing logic; it probes
the current Comix runtime for an HTTP client that can return a typed chapter
list. BrowserSession then calls that provider-resolved runtime client for
protected cache ingestion. Chapter-list discovery asks the runtime client for
`/manga/{mangaId}/chapters`; chapter page-map discovery asks the runtime client
for `/chapters/{chapterId}`, normalizes `pages.baseUrl + pages.items[]` into
full `ChapterPage` URLs, and includes `source=runtime-http` plus `targetCount`
in the normalized payload. Public Comix endpoints may use direct backend fetch
when that is the owning path, but protected chapter data must stay behind the
provider-resolved browser runtime boundary.

Chapter-image cache readiness is a completeness contract:

- status must be `ready`
- source must be `runtime-http`
- `targetCount` must be positive
- `pages.length` must equal `targetCount`
- every page must have a populated image URL

Rows that are encrypted, empty, partial, DOM-observed, or otherwise incomplete
may exist as diagnostics, but the cache route must answer `warming` instead of
serving them as hits. The frontend also rejects zero-page chapter payloads so
the reader cannot mark an empty chapter as successfully loaded.

The cache layer expands each real discovered store URL across known
`wowpic*.store` hosts by preserving the path and replacing only the host when a
chapter-image response is served. This expansion is a generated view, not
durable data.

A 2026-05-11 storage audit found that persisting 25 generated full URLs per
image had created 23.6M `image_store_candidates` rows and about 7.9 GB of
table/index bloat inside a 9.43 GB database. Dropping that table, vacuuming
SQLite, and generating candidates on demand reduced the DB to about 1.43 GB.

With generated candidates removed, the dominant growth model is approximately
one canonical page-map row per chapter instead of 25 generated candidate rows
per image. The current sample projects full canonical metadata storage around
32-35 GB rather than terabyte scale:

- 88,889 manga in `manga_cache`
- 17,772 cached chapter lists with 883,481 known chapters
- about 49.71 chapters per manga on average
- about 4.42M projected chapter page maps
- about 6.8 KB DB cost per canonical chapter page map

Background data caching is therefore enabled. At the observed post-restart
rate of about one page-map job per second, full page-map completion is expected
to take weeks, roughly 51-57 days unless throughput changes. This is acceptable
because storage growth is now real data growth, not generated URL
multiplication.

This was verified on 2026-05-09 by hard-killing
`manga-reader.service` with `systemctl --user kill --signal=KILL`, starting it
again, and checking logs/status. The restarted backend recovered from SQLite,
skipped cached chapter lists, recovered durable jobs, and continued cache work
without corruption.

The chapter-image readiness contract was verified on 2026-05-09 with
`7ez2/8996924`: the backend first rejected the previous `empty pages=0` cache
row as `not-ready`, promoted the foreground image job, then cached and served
`source=runtime-http pages=15 targetCount=15 status=ready`.
