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
- Cache code owns durable provider-scoped data and background jobs.
- Frontend owns active provider selection and user intent.
- Favorites/session/search state must be provider-scoped.
- Reader consumes normalized manga/chapter/page data and should not know whether a provider uses stores, scrambling, direct images, or browser extraction.
- Logs must include `providerId` for provider/cache/search/reader/comment events so behavior can be verified from service logs.

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
2. Make cache data and durable jobs provider-scoped.
3. Make frontend active-provider state explicit and persisted.
4. Make search/favorites/session roots provider-scoped.
5. Implement `mangadotnet` provider in the backend provider layer.
6. Add provider switcher UI.
7. Wire search, manga details, chapter list, recommendations, reader images, and comments through normalized provider/cache APIs.
8. Add logs and verification flows before claiming behavior works.
9. Update `decisions.md` when provider architecture is implemented or when investigation proves constraints.

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
