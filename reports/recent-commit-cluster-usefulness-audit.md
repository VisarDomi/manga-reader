# Recent Commit Cluster Usefulness Report

Scope: commits from `4fb57e5 Fix Comix v1 reader loading` through
`06e45b2 Use native scrollend for reader rebases`, plus the current code those
commits left behind.

The boundary matters. `4fb57e5` is the first commit after the earlier gap
(`52c6646` was 9 days ago in the graph), so this cluster includes not only the
later reader/cache architecture, but also the first Comix v1 recovery, metadata
prewarm, comments, recommendations, nested manga layers, and several ideas that
were later removed.

This report is not a changelog. It answers: how much of the cluster is real
architecture for this app's constraints, and how much is bloat or temporary
scaffolding?

## Summary

The current app is meaningfully better because of this cluster, but the path was
not linear. The first part of the cluster grew live Comix-facing behavior around
BrowserSession and frontend prewarm. The second part discovered that this was
the wrong long-term owner model and moved the app toward durable local cache,
bounded reader projection, and explicit layer restore.

Current verdict:

- Most surviving complexity is useful and tied to real constraints: local PWA,
  iOS Safari, fast infinite scrolling, cached metadata/covers, restore, swipe
  layers, and cache invalidation.
- A lot of earlier complexity was transitional. It was useful for learning and
  keeping the app alive after Comix v1 changes, but it would be bloat if it had
  remained.
- The largest current complexity is still the reader. That is expected: it is
  solving a hard browser/scroll problem, not just rendering images.
- The cache engine is large but justified. It replaced UI-edge prewarm and
  random live fetching with a durable data owner.
- The remaining cleanup candidates are narrow: temporary reader image candidate
  randomization, heavy diagnostics/log naming, BrowserSession runtime fragility,
  and `Reader.svelte` size.

The biggest architectural lesson from the cluster is that the app became fast
when ownership moved away from "views fix missing data just in time" and toward
"cache owns data, reader owns projection, DOM owner writes scroll, layers restore
foreground first."

## Cluster Phases

### Phase 1: Comix v1 Recovery and Live Prewarm

Commits:

- `4fb57e5 Fix Comix v1 reader loading`
- `337b4f9 Prewarm reader chapter metadata`
- `dae14b1 Prewarm chapter stats for manga cards`
- `7590d2d Load manga detail metadata asynchronously`
- `29b92db Add manga recommendations`
- `86ddfab Match recommendation cards to manga list`
- `9a2dd7b Prewarm visible manga lists consistently`
- `62128e1 Prewarm likely chapter details`

Usefulness: medium historically, low as final architecture.

This phase made the app work after Comix changed. It restored reader loading,
chapter metadata, card stats, details, recommendations, and list prewarm.
Without it, the app was broken.

But as architecture, much of it was a dead end. It put too much responsibility
at the frontend/view edge:

- cards warmed their own chapter stats
- visible lists triggered provider work
- manga details loaded sections independently
- reader relied on prewarm because upstream data was not locally available
- BrowserSession became the expanding owner of provider details

That explains why later commits delete large chunks:

- `9307cd3 Remove obsolete prewarm paths`
- `4d711db Remove card-owned chapter stat warming`
- `c71c10e Simplify chapter stat card state`
- `bd33d52 Remove legacy live proxy route`

Verdict: useful as recovery scaffolding, not something to preserve. The current
code is healthier because most of this phase was replaced by cache ownership.

### Phase 2: Comments, Recommendations, and Detail Surface

Commits:

- `67bbb36 Add lazy manga comments`
- `a31771d Render complete manga comment threads`
- `3d9e104 Add chapter-specific comments view`
- `1f4d38b Render spoiler and image comment parts`
- `3d31993 Preload chapter comments during swipe`
- `a2f517d Fix deep comment loading and indentation`
- `e1dc07c Always fetch fresh comments`
- `bd4897d Move comments off browser session`

Usefulness: high product value, medium architectural cost.

Comments and recommendations are real app features, not bloat. The current code
has the right final direction: comments are live and no-store, but no longer
depend on BrowserSession for the whole workflow. `CommentsService` gets the
provider identifiers from cached manga data and then uses backend fetches.

The deep comment indentation fix was useful UI architecture: cap visual nesting
instead of letting the layout become Hacker News style indentation collapse.

The cost is that comments are still a provider-specific live path. The route
logs now use endpoint-owned labels (`[comments]`) instead of the old generic
proxy label, so the logs match the current ownership model.

Verdict: keep the feature and the separate `CommentsService` owner.

### Phase 3: Layered Navigation and Restore

Commits:

- `529d2dd Add manga detail navigation stack`
- `5bc5445 Stop auto-scrolling manga details to current chapter`
- `4e5e975 Fix restored reader back stack`
- `efa5419 Document persisted navigation restore lesson`
- `0c1e0ae Keep nested manga detail layers mounted`
- `50f694d Update decisions for restore ownership`
- `c9aa981 Separate favorites from search lifecycle`
- `6f8d627 Remove favorites hibernation complexity`
- `ee632c1 Restore foreground shell before hydration`
- `718a345 Restore scroll per manga layer`
- `2ea5185 Prime restore foreground before hydration`

Usefulness: high.

This is core to the app. Search/favorites, manga details, reader, and comments
are not fake routes. They are real stacked layers with independent scroll,
gesture, and restore behavior.

The most important fix in this phase was foreground-first restore:

- restore the visible shell immediately
- hydrate data behind that shell
- restore per-manga-layer scroll positions
- replay search only when the search root owns search context
- keep search and favorites separate roots

This fixed the earlier symptom where restore could briefly show search/favorites
or do work for the wrong root before landing on the right layer.

Verdict: necessary. This is not bloat. The app's fast navigation and swipe-back
behavior depends on this ownership model.

Remaining risk:

- `AppState` is large because it owns restore orchestration. That is acceptable
  while restore crosses search, favorites, manga, reader, and comments. Splitting
  it too early could hide the ownership model rather than simplify it.

### Phase 4: Early Reader Ownership Rewrite

Commits:

- `97b5403 Fix reader scroll ownership during restore`
- `464f9be Capture reader progress on close`
- `949cd76 Rewrite reader window ownership`
- `aa1070e Separate reader layout ownership from visibility`
- `db6b332 Drive reader window from scroll geometry`
- `293e912 Pin reader virtual slot estimates`
- `41b1894 Add reader visual diagnostics`
- `329898f Record reader baseline commit`
- `4df7292 Fix reader boundary ownership`
- `221d856 Fix reader idle layout ownership`
- `a70b1c1 Update reader decisions for virtual windows`

Usefulness: mixed historically, high as learning, medium as surviving code.

This phase found the right problem but not the final shape. It separated layout
ownership from visibility and began moving away from intersection observers as
authority. That was the correct direction.

It also introduced several intermediate fixes around estimates, visual
diagnostics, and boundary ownership. Some were necessary to see what Safari was
doing; some became obsolete after the bounded physical scroller.

The important surviving lesson:

- visibility is observation, not authority
- scroll geometry is the input
- layout ownership belongs in a reader state/service owner, not scattered
  through individual DOM events
- progress save on close is necessary because interval saves are not enough

Verdict: not bloat as a development phase, but not all of it should be treated
as final architecture. The current code absorbed the useful ideas and replaced
the weak ones later.

### Phase 5: Reader Performance and Swipe Jank

Commits:

- `3dcfc21 Fix reader foreground work ownership`
- `061894e Optimize reader foreground performance`
- `df7c94c Smooth chapter comments swipe`
- `e57a375 Reduce manga swipe reactive pressure`
- `191373d Refine swipe jank ownership logs`
- `957a80c Add frontend performance diagnostics`

Usefulness: high for diagnosis, medium for lasting code.

This phase proved that Svelte `$state` writes and per-frame work could make the
UI feel heavy even when network work was finished. It reduced reactive pressure
during gestures and moved reader foreground work out of hot paths.

The useful surviving pattern:

- gesture movement should not write broad `$state` every frame
- diagnostics should summarize main-thread/frame behavior instead of spamming
  one log per frame
- comments can begin loading on swipe registration without making swipe
  movement reactive-heavy

The temporary part is diagnostics. They were valuable while hunting jank, but
some logging should remain debug-gated or sampled if it becomes noisy again.

Verdict: useful. Not the final source of all speed, but it prevented the app
from confusing "network done" with "main thread idle."

### Phase 6: Search/Favorites Separation and Card State

Commits:

- `3407ca2 Bound list prewarm and prep manga restore target`
- `83030d3 Instrument large manga list prewarm`
- `424ab1c Document search list performance findings`
- `a756cee Use cached details for favorite cards`
- `7a75b7e Store favorites as card snapshots`
- `c658c59 Keep favorites activation resident`
- `9393263 Checkpoint favorite snapshot invalidation`

Usefulness: high for the current app, with one intentional tradeoff.

The critical discovery was that search and favorites are different roots. A
restore to favorites must not also rebuild an old search result list. That
removed a large source of perceived app heaviness.

Favorite snapshots are also useful: favorites should render like search cards
without a hydration waterfall. IndexedDB stores enough card data to construct
the item immediately, while cache reconciliation repairs stale stats.

Intentional tradeoff: `MangaList` still mounts the list rather than virtualizing
chapter/search/favorite cards. That is not accidental. The user rejected
behavior-changing list virtualization. For 20 favorites and normal search use,
the current approach is acceptable. For 1000+ search results, it can still be a
stress path, but it is no longer loaded accidentally during favorites restore.

Verdict: necessary. The separation is a real ownership improvement, not bloat.

### Phase 7: Cache-Only Data Model

Commits:

- `739501b Add durable backend cache service`
- `4b69bf0 Add cache-only reader data path`
- `9307cd3 Remove obsolete prewarm paths`
- `75bf18f Use cache warming for manga details`
- `bd33d52 Remove legacy live proxy route`
- `56a0eef Make live search explicit`
- `86cc5c4 Add cache reconciliation from search`
- `a644e48 Add durable cache scheduler and byte cache`
- `bf7a8f9 Enqueue chapter page maps from cached chapter lists`
- `7fddafb Prioritize new daily crawl frontier`
- `86b57b1 Document durable cache ownership`
- `e81f40f Schedule daily cache crawl rollover`
- `eefc29d Retry stale byte cache failures`
- `d53870a Own chapter warmup promises in scheduler`
- `5b159cd Yield cache jobs to foreground requests`
- `25af7b7 Drain durable cache backlog on startup`

Usefulness: very high.

This is the biggest lasting architecture change in the cluster. It replaced
frontend-driven provider work with a local cache owner:

- structured data lives in the backend cache
- cache jobs are durable in SQLite
- duplicate jobs collapse by kind/resource
- priorities distinguish foreground, observed, daily, and background work
- power-off recovery works through leases and recovery
- daily crawl refreshes the frontier at the configured time
- foreground requests promote relevant work

The current app direction depends on this. Without it, manga details, chapter
lists, and reader image metadata would still be live Comix calls at the moment
of user interaction.

Verdict: necessary. The code is large because it owns a real queue, persistence,
priority, retries, and cache invalidation. That is useful complexity.

Remaining risk:

- The cache engine still has enough moving parts that job naming must stay
  precise. "chapter image" means page-map/store metadata, not image bytes; that
  already caused confusion.
- Long background crawls must remain observable because the data set is large.

### Phase 8: Provider and BrowserSession Ownership

Commits:

- `11f7098 Move Comix server logic behind provider owner`
- `daf760b Remove obsolete provider signing fields`
- `bd4897d Move comments off browser session`
- `b12bdb5 Own manga cover byte cache`

Usefulness: high, with one fragility.

Moving Comix-specific logic behind `packages/server/src/providers` is correct.
The app should not leak provider URL shapes and runtime details across generic
routes.

Removing explicit signed-field/minified export ownership was also correct. The
old path was brittle because it depended on specific Comix runtime internals.
The current provider still discovers a runtime HTTP client inside a browser page,
but it behaviorally probes for the client instead of hard-coding one minified
symbol.

Comments moving to `CommentsService` was a major cleanup. BrowserSession no
longer owns comment traversal.

Verdict: necessary cleanup. The one remaining fragility is runtime HTTP itself:
it is still a browser-backed provider capability. That may be unavoidable for
Comix unless a stable public API is found, but the fragility is now contained in
the provider/BrowserSession boundary.

### Phase 9: Byte/Cover Cache

Commits:

- `a644e48 Add durable cache scheduler and byte cache`
- `b12bdb5 Own manga cover byte cache`

Usefulness: high.

The final distinction is important:

- covers/thumbnails are byte-cached and served locally
- reader page images are not byte-cached
- reader page metadata stores canonical URLs and generates store candidates on
  read

This is the correct split. Covers are small, repeated, and visible in lists and
detail pages. Reader pages are large and would explode storage if byte-cached.

Verdict: necessary and not bloat.

### Phase 10: Lean Reader Image Candidate Cache

Commits:

- `6a23b8a Rewrite reader image candidate cache`
- `d92889d Document lean cache storage model`

Usefulness: very high.

This removed the bad 2 TB trajectory. The previous idea cached generated store
candidates, which multiplied data by store count. The current architecture
caches unique canonical page data and generates candidates at request time.

This is exactly the kind of ownership correction the codebase needed:

- database owns only real data
- provider/cache code owns generated candidates
- frontend reports candidate status observations
- future deterministic candidate ranking can use those observations

Verdict: necessary. This is one of the highest-value commits in the cluster.

Current temporary behavior:

- candidate order is random to collect data. This should be replaced by smart
  deterministic ordering once enough observations exist.

### Phase 11: Final Reader Projection and Rebase Architecture

Commits:

- `0a336e4 Bound reader physical scroll surface`
- `e0a2ee9 Fix reader virtual window cursor ownership`
- `8a8e390 Refine reader virtual window ownership`
- `468403b Refine reader and manga detail ownership`
- `25fb26d Fix reader window residency ownership`
- `b9ecf5f Separate reader scroll settled ownership`
- `cc94633 Own reader physical projection epochs`
- `17b9445 Replace reader settle timers with projection transactions`
- `3c11e13 Defer reader rebases until motion is stable`
- `2dba55f Revert "Defer reader rebases until motion is stable"`
- `9121157 Tighten reader projection ownership`
- `13d8ab5 Own ready reader slot heights`
- `4325b3c Add reader scroll session rebase owner`
- `7ad431c Document reader idle rebase delay`
- `06e45b2 Use native scrollend for reader rebases`

Usefulness: very high.

This is the core answer to iOS Safari plus fast infinite scrolling.

The constraints are real:

- unlimited DOM height breaks down on iOS Safari
- prepending/removing above the viewport is destructive to scroll position
- image loading/unloading can flash black if visible images are revoked
- logical manga progress must keep moving across many chapters
- physical browser scroll must stay bounded
- rebasing the physical runway must not happen during momentum

The current split is the best architecture the cluster reached:

- `ReaderWindowManager` owns logical chapter layout and window candidates
- `ReaderState` owns projection, logical cursor, physical runway, and epochs
- `Reader.svelte` owns DOM reads/writes and native `scrollend`
- `ReaderMemoryManager` owns image blob URL lifetimes
- projection transactions own programmatic scroll writes until acknowledged
- native `scrollend + 100ms` owns physical rebase permission

The earlier stable+1000ms approach was a useful test but worse final design. It
was still a timer-based inference. Native `scrollend` with a short quiet period
is cleaner because it gives one browser event ownership over "the user scroll
ended" and avoids dual authorities.

Verdict: necessary. This is not bloat. The code is complex because the browser
does not give a simple primitive for this app's requirement.

Remaining risk:

- If native `scrollend` is missing or lies in another PWA/browser environment,
  this should be treated as a platform support/logging issue, not silently
  hidden behind a second guessed timer.
- `Reader.svelte` is still operationally large. It is mostly DOM-adjacent, but
  future cleanup could extract a small "projection transaction DOM adapter" if
  the file becomes hard to reason about.

## What Is Actually Useful

High-value surviving architecture:

- cache-only manga detail/chapter/image metadata reads
- live search and live comments as explicit narrow exceptions
- durable cache jobs with priority, lease recovery, retry, daily crawl
- cover byte cache
- lean canonical image URL storage with generated candidates
- foreground restore shell before hydration
- per-manga-layer scroll snapshots
- search/favorites root separation
- favorite card snapshots in IndexedDB
- comments moved out of BrowserSession
- bounded reader physical runway
- reader logical/physical coordinate split
- reader projection epochs and transactions
- native reader `scrollend + 100ms` rebase owner
- `ReaderMemoryManager` preserving visible/nearby images
- capped comment indentation

These are not decorative abstractions. Each maps directly to a bug class that
was seen: scroll jumps, black screens, heavy swipes, stale favorites, Comix
latency, wrong restore root, comments failure, or database blow-up.

## What Was Bloat Or Transitional

Mostly removed already:

- card-owned chapter stat prewarm
- visible-list prewarm as a primary data strategy
- live proxy routes for manga details/chapter lists/reader images
- BrowserSession owning comments
- explicit minified signing/export assumptions
- generated reader image candidate rows in SQLite
- search/favorites coupling
- hibernation complexity around favorites
- stable+1000ms reader rebase gate
- source comments duplicated with `decisions.md`

Surviving but acceptable:

- diagnostics and logs are still broader than a quiet production app, but the
  user wants logs on because they are the proof channel.
- route-level search/comment logs use endpoint-owned labels; generic
  `proxyFetch` remains the transport utility name.
- random image candidate ordering is temporary and documented in `todo.md`.
- `Reader.svelte` is large. It is not obviously wrong, but it is the file most
  likely to accumulate future accidental ownership leaks.

## Bloat Risk By File

### `packages/app/src/lib/components/Reader.svelte`

Risk: medium.

It owns DOM scroll, scrollend, projection transactions, measurements, logging,
and visible surface observation. That is a lot. Most of it belongs near the DOM,
but the file is now the main complexity hotspot.

Not immediate bloat:

- DOM writes must stay close to DOM ownership.
- Projection transactions need direct scrollTop observation.
- Native `scrollend` handling is DOM-specific.

Future cleanup candidate:

- extract a small DOM adapter for projection transaction bookkeeping if another
  reader bug makes the file hard to audit.

### `packages/app/src/lib/state/reader.svelte.ts`

Risk: low-medium.

Large, but it owns real reader state: layout, projection, progress, image pages,
scroll restoration, and memory planning inputs. The split with
`ReaderWindowManager` and `ReaderMemoryManager` is good.

### `packages/server/src/cache/CacheService.ts`

Risk: medium.

Large, but it owns durable structured cache behavior. The size is justified by
the number of job kinds and invalidation paths. The risk is naming and job
semantics drifting. Keep `decisions.md` and logs precise.

### `packages/server/src/services/BrowserSession.ts`

Risk: medium-high.

It is smaller and cleaner than it was, but still browser-backed and therefore
fragile. The runtime HTTP client is behaviorally resolved instead of minified
symbol-owned, but it still depends on Comix runtime behavior.

This is acceptable only because the provider boundary contains it.

### `packages/app/src/lib/state/index.svelte.ts`

Risk: medium.

It is the restore and layer orchestrator. It looks heavy, but splitting it
without care could make restore less obvious. Its ownership is currently clear:
it coordinates layers, it does not own the internals of each layer.

## What We Tried And Correctly Removed

- Prewarm as core architecture: removed because cache is the real owner.
- Favorite/search relation: removed because they are exclusive roots.
- Hibernating favorites: removed because it introduced complexity and visible
  behavior changes.
- Generated image candidate cache: removed because it caused the 2 TB path.
- Reader stable+1000ms rebase: removed because native `scrollend` gave a better
  owner.
- BrowserSession comments: removed because comments can use cached identifiers
  plus backend fetch.
- Duplicated source comments: moved into `decisions.md` to avoid drift.

These removals are a good sign. The cluster was not just additive; it repeatedly
deleted weak ownership ideas after logs/tests disproved them.

## Current Architecture Quality

Overall: good, with a few known pressure points.

The final codebase is not minimal, but it is much more coherent than the middle
of the cluster. The current architecture is aligned with the app's constraints:

- The frontend mostly consumes local cache.
- Search and comments are explicit live exceptions.
- Covers are local bytes.
- Reader pages use generated store candidates, not local byte cache.
- The reader has a bounded physical runway and a separate logical model.
- Restore shows the intended layer first.
- Cache invalidation is done by search observation, daily crawl, foreground
  priority, and frontend candidate reports.

That is the right shape for a local PWA that needs fast navigation and long
reader sessions on iOS Safari.

## Current Weak Spots

1. Reader candidate ordering is intentionally random.

   This is temporary and useful for collecting store quality. It should become
   deterministic once observations are enough.

2. BrowserSession runtime HTTP is still provider-fragile.

   It no longer hard-codes minified symbols, but it still relies on the provider
   runtime being available in a browser page.

3. Reader logs/diagnostics are still broad.

   Logs are currently valuable because subtle reader bugs are hard to reproduce.
   If the app stays stable, debug-only gating or sampling can reduce noise.

4. `Reader.svelte` remains a high-attention file.

   It is not obvious bloat, but future changes should be especially strict about
   ownership. DOM scroll writes should remain single-owner.

5. Search result DOM is still not virtualized.

   This is intentional because behavior changes were rejected. The cache and
   root separation mean it should not accidentally poison favorites/reader
   restore anymore, but 1000+ mounted cards can still be a stress test.

## Necessity Rating

Clearly necessary:

- Comix v1 recovery
- cache-only detail/chapter/image metadata paths
- durable cache jobs
- lean canonical image storage
- cover byte cache
- search/favorites separation
- favorite card snapshots
- foreground-first restore
- per-layer manga scroll restore
- comments service extraction
- bounded reader physical projection
- projection epochs/transactions
- native scrollend rebase owner
- reader memory ownership

Useful but transitional:

- early live prewarm
- early manga-card stat warmup
- visual diagnostics
- large search performance probes
- stable+1000ms reader rebase experiment
- baseline/report commits

Potential bloat if left forever:

- random image candidate ordering
- broad reader diagnostics if left always-on after the app is stable
- any future return of view-owned prewarm logic

## Final Judgment

The current state is not bloated in the way the middle of the cluster was. The
middle of the cluster had bloat because UI views and BrowserSession were trying
to compensate for missing local data and unclear scroll ownership. The current
state moved those responsibilities to the right owners.

The useful work was not one magic fix. It was the accumulation of several
ownership corrections:

- data moved from live/prewarm to durable cache
- generated image candidates moved out of storage
- favorites/search stopped sharing lifecycle
- restore became foreground-first
- comments moved out of BrowserSession
- reader split logical scroll from physical scroll
- DOM scroll writes became transaction-owned
- rebase permission became native-scrollend-owned

So the codebase is larger than before, but most surviving size is now structural
load-bearing code. The bloat to watch for is not "too many lines"; it is any
future code that reintroduces ambiguous ownership: view-owned provider warming,
multiple scroll writers, hidden timer gates, generated cached data, or coupled
search/favorites state.
