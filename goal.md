# Goal: Add Mangadot Provider

Read this file after context compaction before continuing this work.

## Objective

Add `mangadot.net` as a second provider beside `comix`, while keeping provider-specific behavior owned by provider code and keeping app/cache/reader layers provider-neutral.

The end state should let the app choose an active provider from a new `Providers` root control next to Search and Favs. Search, favorites, manga details, reader, recommendations, comments, and background cache must be scoped to the active provider.

## Product Requirements

- Add a `Providers` button/root view next to `Search` and `Favs`.
- User can select between `comix` and `mangadotnet`.
- Favorites are provider-specific. `mangadotnet` starts with zero favorites.
- Search works for `mangadotnet` using the site's `/search` behavior.
- Manga details for `mangadotnet` should support:
  - title/cover/metadata
  - chapter list
  - scanlation/group filtering
  - all languages by default for now
  - "You may also like" as recommendations
  - manga comments if feasible
- Reader for `mangadotnet` should support:
  - chapter images
  - chapter comments if feasible
  - fast bounded infinite scrolling using the existing reader architecture
- Cache should cache both providers without ID collisions or provider-specific data leaking across providers.

## Ownership Rules

- Provider code owns provider-specific URLs, parsing, browser/runtime access, image semantics, comments identifiers, and search/filter shapes.
- Server provider registry/coordinator owns provider selection on the backend.
  Routes ask the coordinator for a provider runtime/cache by provider id; routes
  do not import `comix` or `mangadotnet` directly.
- Cache code owns durable provider-scoped data and background jobs. A cache row,
  durable job, byte/cover object, image-store observation, and background worker
  lease must have exactly one provider owner. Do not let Comix and Mangadot share
  ID-only keys.
- Frontend owns active provider selection and user intent. It may send the
  active provider id with requests, but it must not know provider browser
  profiles, Cloudflare clearance, Comix store-host rules, or Mangadot API
  route details.
- Favorites/session/search state must be provider-scoped. Switching provider is
  a root switch, not a filter on the same root state. `mangadotnet` favorites
  start empty even if the same manga id exists in another provider.
- Reader consumes normalized manga/chapter/page data and should not know whether a provider uses stores, scrambling, direct images, or browser extraction.
- Logs must include `providerId` for provider/cache/search/reader/comment events so behavior can be verified from service logs.

## Ownership Boundary Polish Required

Adding Mangadot is not only a new provider implementation. It is the point where
the single-provider assumptions in the current app must be replaced with clear
owners:

- `ProviderRegistry`: lists providers and exposes provider capabilities.
- `ProviderRuntimeOwner`: owns browser/profile/session acquisition for a single
  provider. For Comix this means runtime HTTP from the site module; for
  Mangadot this means human-bootstrapped Cloudflare clearance reused by Xvfb.
- `ProviderCacheOwner`: owns one provider's data cache, byte/cover cache,
  durable jobs, and background worker lifecycle.
- `ProviderRouteCoordinator`: maps request provider id to the right provider,
  runtime owner, cache owner, byte cache owner, and comments owner.
- `FrontendProviderState`: owns active provider selection, persists it, and
  invalidates provider-local roots when switching.

Avoid implementing this as scattered `?providerId=` conditionals that leave the
old Comix singleton in charge. Passing `providerId` through requests is allowed
only as an address to the coordinator; it is not the ownership model.

Comix-specific behavior that must stay out of generic code:

- store-host candidate generation and smart store ranking
- frontend image-store observations
- scrambled page decoding
- Comix runtime module discovery

Mangadot-specific behavior that must stay out of generic code:

- Cloudflare human-clearance/session status
- Xvfb profile reuse
- direct `/api/manga/*`, `/api/uploads/*`, and React Router stream parsing
- direct image URL semantics without store fanout or descrambling

## Investigation Checklist

For `mangadot.net`, verify with browser-backed tests before implementing each area:

1. Search
   - Search URL/query shape.
   - Result card fields: id, title, cover, latest chapter/update info.
   - Whether requests need browser/session/cookies/signing.

2. Manga Details
   - Stable manga id and canonical URL.
   - Metadata fields available.
   - Recommendation/"You may also like" extraction.
   - Comments identifiers and request shape.

3. Chapter List
   - Pagination or embedded chapter list.
   - Group/scanlation fields.
   - Language fields.
   - Chapter ids, numbers, titles, upload dates.

4. Reader Images
   - Whether image metadata is available from page data or network calls.
   - Whether images are direct, store-host candidates, proxied, referer-bound, CORS-bound, or scrambled.
   - Whether the existing Comix descrambler/store-selection code is provider-specific and should not be reused.

5. Comments
   - Manga comments.
   - Chapter comments.
   - Whether comments need browser/session, simple fetch, or are not worth implementing initially.

## Implementation Plan

1. Add provider registry/coordinator rather than hard-coding a single server provider.
2. Split runtime ownership per provider. Browser sessions must be keyed by
   provider and must expose session health, especially Mangadot
   `needsHumanClearance`.
3. Split cache ownership per provider. Prefer provider-owned cache services or
   provider-scoped databases over shared ID-only tables. If a shared database is
   used later, every key must include provider id.
4. Keep provider-specific image policies behind provider/cache owners. Comix
   store/decoder logic must not run for Mangadot direct images.
5. Make frontend active-provider state explicit and persisted.
6. Make search/favorites/session roots provider-scoped.
7. Implement `mangadotnet` provider in the backend provider layer.
8. Add provider switcher UI.
9. Wire search, manga details, chapter list, recommendations, reader images,
   and comments through normalized provider/cache APIs.
10. Add logs and verification flows before claiming behavior works.
11. Update `decisions.md` when provider architecture is implemented or when investigation proves constraints.

## Validation

- Use repo scripts, especially `npm run restart`, for rebuild/restart.
- Check logs with:
  `journalctl --user -u manga-reader.service --since '<build timestamp>' --until now --no-pager`
- Verify separately:
  - provider switching
  - `comix` still works
  - `mangadotnet` search
  - `mangadotnet` manga details
  - `mangadotnet` reader first image
  - provider-specific favorites
  - background cache progress per provider
