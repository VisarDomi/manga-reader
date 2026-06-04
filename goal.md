# Goal: Provider Filter Semantics

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
