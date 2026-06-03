# Goal: Provider Filter Semantics

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
