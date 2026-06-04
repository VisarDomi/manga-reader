# Goal: Provider Warm Paths, Foreground Cache Ownership, and Mangadot Value

## Current Active Goal 2026-06-04 Second Pass

New user-facing regressions to investigate before fixing:

1. The app currently cannot be opened reliably. Evidence must come from the
   managed service logs, health endpoints, and frontend runtime logs before
   claiming whether this is a service, startup, route, provider, or frontend
   failure.
2. Foreground UI must not block on provider cold work when stale cache exists.
   The intended behavior is: serve any cached manga/search/chapter/image
   metadata immediately, enqueue or promote the provider refresh as a high
   priority background job, and atomically update the UI when fresh data lands.
3. Mangadot cache value is unproven. Investigate whether caching Mangadot
   chapters/images produces warm paths or whether runtime/Cloudflare/direct
   image fallback still dominates foreground latency.
4. Comix cache value is inconsistent from the user's point of view: sometimes
   faster than the site, sometimes slower. Investigate whether slow cases are
   cache misses, decoder work, store-selection policy, foreground/background
   contention, or UI waiting on refresh instead of serving stale cache.
5. Warm-path invariant remains: after startup, normal usage should hit warm
   provider sessions or durable cache. Cache misses should be priority work,
   not foreground UI stalls when stale data exists.

Evidence targets:

- service health and app root response
- provider readiness and warmup timings
- cache-read/cache-write/search/chapter-images logs with provider ids
- foreground request latency vs background cache job activity
- whether current app-open failure correlates with Mangadot background aborts,
  browser process runaway, frontend runtime errors, or bad cached state

Do not hide failures behind gates/timeouts. If logs are insufficient, improve
structured logs around the ownership boundary that is blind.

Findings/fixes from this pass:

- The app-open failure was a frontend boot ownership bug: `AppState` read
  `getProvider().getFilters()` before `initProvider()` had installed the active
  provider. `providerFilters` now starts as an empty snapshot and is populated
  only after provider init.
- Foreground manga detail should not block on a warming/missing chapter list
  when cached/detail-card data exists. The detail owner now commits available
  manga detail immediately and marks chapters as updating; the refresh owner can
  replace the chapter list when the backend cache finishes.
- Provider switch leaked through favorite hydration. A favorite row load now
  captures its provider id, and card snapshot requests, parsing, IDB snapshot
  writes, and chapter stats all remain scoped to that provider. Late old-provider
  hydration is cancelled.
- The Mangadot durable queue had poisoned `favorite-card-cache-miss` jobs from
  old Comix favorite ids. Mangadot cache startup now purges non-numeric durable
  favorite-card miss jobs and logs the repair. Verified after restart:
  `favorite-card-cache-miss` jobs in Mangadot cache = `0`.
- Verified after restart on 2026-06-04 13:20:02: `/api/providers` returned both
  providers ready in `0.635s`; Xvfb app-open rendered the Comix search grid;
  frontend boot logged `boot-ready` in `2422ms`; Comix search returned `100`
  results in `2309ms`; visible cover cache hits were served from local cache.

---

# Previous Goal: Provider Filters and Mangadot Reader Images

## Current Active Goal 2026-06-04

Checkpoint `ee7d207` fixed provider-owned filter catalogs and was pushed.

Next tasks:

1. Mangadot reader images were failing at the frontend image load layer:
   cached metadata returned one direct `mangadot.net` candidate per page, and
   the browser logged `reader-image-candidate ok=false status=0`. The fix is
   provider/cache ownership: Mangadot cache still stores the canonical direct
   URL, but render candidates are local `/api/cache/.../image` URLs. Verified
   after restart: the local route returned `200 image/webp`; plain backend
   proxy got upstream `403`, then provider-owned runtime byte fetch succeeded.
2. Frontend filter definitions are now AppState-owned and provider-keyed. The
   filter panel derives from `appState.providerFilters`, and in-flight provider
   filter refreshes are keyed by provider id so one provider cannot overwrite
   another after a switch.
3. FilterPanel "Clear All" was removed.
4. Mangadot filtered search remains provider-document-owned. Adding `limit=100`
   to `/search?...` did not change the provider's `per_page=28`; the route
   still logged `count=28 current=1 last=349 total=9758`.
5. Comix scrambling is still present; lack of visible errors means the decoder
   is working. Recent logs showed `scrambled>0`, decoder cache/miss activity,
   source recovery, and local-decoder image candidates.

Keep these ownership targets:

- Provider owns filter catalog discovery and provider-specific query shape.
- Frontend owns only per-provider selected filter state.
- Reader owns provider-neutral page rendering; provider/cache owns whether
  image URLs are direct, generated store candidates, or decoded.
- Logs must distinguish cache-metadata success from frontend image-load success.

## Runtime/cache invariant

Normal usage should be warm. The only acceptable cold runtime path is immediately
after the computer/service starts or after a provider loses its browser session.
After startup:

- provider browser sessions keep their human-cleared profile outside `/tmp`
- foreground runtime HTTP is warmed before the provider is reported ready
- background runtime HTTP is warmed before background cache jobs resume
- foreground cache misses can still happen for never-seen manga, but they should
  become durable cache work and subsequent opens should be cache hits
- provider status must say not ready / needs human clearance when runtime API
  calls are Cloudflare-blocked, not merely when Chromium launched

Verify and fix provider tag filters end to end.

Current user-facing bug to preserve through compaction:

- Search filters should be saved locally in the frontend per provider.
- Filter definitions/catalogs should be cached in the backend per provider and
  refreshed daily.
- Comix filters currently appear to work.
- Mangadotnet filters sometimes return HTTP 500 and sometimes work but return
  page size `28` instead of `100`; verify whether `28` is a provider document
  limit for filtered searches or a bug in our request/parser/cache path.
- Mangadotnet and Comix showing the same exact filter catalog is suspicious and
  must be treated as a cache/ownership bug unless logs prove otherwise.

Target ownership:

- Frontend owns only local selected filter state keyed by provider.
- Backend cache owns provider filter catalogs keyed by provider and option type.
- Provider owns translating generic filter intent into provider-specific query
  parameters/routes.
- No provider may read or overwrite another provider's cached filter catalog.

The cached filter catalog is only correct if each cached option can be used by
the provider search path in all three UI states:

- neutral: option absent from filters
- include: option appears in `includeGenres`
- exclude: option appears in `excludeGenres`

For both `comix` and `mangadotnet`:

1. Prove what IDs/names the provider expects for tag include/exclude filters.
2. Prove whether a cached tag such as Romance changes search results when
   included and excluded.
3. Keep provider-specific URL/query translation inside provider code.
4. Keep the frontend generic: it only toggles cached options.
5. If a provider cannot support a filter semantics, surface that clearly in
   logs instead of pretending the filter works.

Evidence should come from current code, `/api/search`, and provider/runtime logs.

Do not mark this goal complete from provider internals alone. Verification must
exercise the live app-facing path for both providers after a service restart:

- `/api/providers` reports both providers ready.
- `/api/provider-filters/:providerId` serves the cached/provider catalog.
- `/api/search` accepts UI-shaped filters for each provider and returns parsed
  results whose totals/items change for include/exclude.
- The frontend filter owner keeps provider filter state separate, so Mangadot
  tags cannot leak into Comix and Comix numeric IDs cannot leak into Mangadot.
- Reader image delivery is verified for each provider. Comix uses generated
  store candidates. Mangadot must be verified separately because it currently
  exposes direct image URLs from provider metadata rather than Comix-style
  store candidates.

## Verified 2026-06-03

- Comix cached tag IDs are provider IDs. `Romance` is cached as id `23`.
  `/api/search` with neutral browse returned total `89563`; include `23`
  returned total `47086`; exclude `23` returned total `42478`. The Comix API
  path is correct when the cached id, not the display name, is sent.
- Mangadot cached tag IDs are display names. `Romance` is cached as id
  `Romance`.
- Mangadot `/api/search?...&genre=Romance` ignored include/exclude filters.
  That path is not valid for filtered search semantics.
- Mangadot `/search?...&genre=Romance` and `/search?...&genre=-Romance`
  return filtered React Router document streams. Include returned `28` items on
  page 1, total `9756`, with first results containing `Romance`. Exclude
  returned `28` items on page 1, total `10000`, with first results not
  containing `Romance`.

Implementation result:

- Comix keeps API search for filters.
- Mangadot uses API search for unfiltered search/browse, preserving `100` item
  pages.
- Mangadot uses document search for filtered search, preserving correct
  provider semantics even though the page size is provider-fixed at `28`.

## Verified 2026-06-04

- The user service is enabled and active after a power-loss restart:
  `systemctl --user is-enabled manga-reader.service` -> `enabled`,
  `systemctl --user is-active manga-reader.service` -> `active`.
- Mangadot no longer stores the human-cleared profile in `/tmp`; it uses the
  persistent provider profile at `~/.cloakbrowser-profiles/mangadot.net`.
- `/api/providers` reports both providers ready after runtime warm-up.
- Comix live search via `/api/search`:
  neutral `100/89579`, include Romance id `23` `100/47094`, exclude Romance
  id `23` `100/42485`.
- Mangadot live search via `/api/search`:
  neutral `100/10000`, include `Romance` `28/9758`, exclude `Romance`
  `28/10000`. It is functionally correct, but provider latency can still be
  high: one warm run measured neutral `42249ms`, include `10420ms`, exclude
  `5256ms`.
- Mangadot cached reader image metadata for manga `26866`, chapter `450803`
  served `17` direct page URLs from cache in `997ms`; the first direct image
  URL returned HTTP `206`, `content-type=image/webp`, with a Cloudflare
  `cf-ray` header in `170ms`.

## Updated 2026-06-04 Filter Cache Fix

- Startup now attempts to refresh each provider's filter catalog when the
  provider cache starts, in addition to the normal 24h TTL refresh path.
- Mangadot filter catalog refresh is owned by the warmed browser/runtime
  document path, not raw backend `fetch`, because raw provider access can be
  Cloudflare-blocked or incomplete.
- Search context persistence is provider-owned. New search contexts include
  `providerId`; replaying a context from another provider logs
  `search-context-provider-mismatch` and reloads the active provider's locally
  saved filters instead of replaying stale filter IDs.
- Verified after restart: Comix startup filter refresh completed and
  `Romance` is `23`; Comix Romance search logged `count=100 total=47094`.
- Verified after final restart: both providers report ready.
- Verified after final restart: Mangadot startup filter refresh completed via
  runtime document fetch, `117` provider-catalog tags, `3` statuses, `4` types.
- Verified after final restart: Mangadot cached filters are provider-specific
  and serve `Romance` as `Romance`, not Comix id `23`. The DB row for
  `Romance` remains `provider-catalog`.
- Mangadot filtered search page size is provider-fixed at `28` for the
  document search path: `/api/search` with include `Romance` logged
  `count=28 current=1 last=349 total=9758 396ms`.
- If Mangadot runtime is blocked during a future restart, foreground search now
  attempts one runtime warm before returning explicit `503 Provider runtime not
  ready`, avoiding the previous generic `500`.
