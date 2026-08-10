# Provider attack vectors

Read-only audit recorded on 2026-08-02. The desired provider contract is one
authoritative source and one explicit parsing rule. A provider should fail
visibly when that contract changes instead of trying alternate sources or
silently manufacturing usable-looking data.

## Highest priority: Dave/Cubari

- The reader selects `Object.keys(chapterData.groups)[0]`. Cubari can expose
  multiple scanlation groups, so object order is an implicit and potentially
  arbitrary content-selection policy. Determine what the groups mean for real
  series, then require one group or encode an explicit group policy.
- `seriesUrl` infers Dave versus Cubari from whether the slug looks base64-like.
  A malformed or newly formatted identifier can therefore be routed to the
  wrong site. Prefer carrying the provider/origin explicitly.
- Chapter sorting uses `parseFloat(chapter) || 0`. Unexpected identifiers are
  silently collapsed to zero instead of exposing a changed chapter contract.

## Metadata fallbacks and silent defaults

- Violet first parses the series title from `HISTORY.push(...)`, suppresses a
  JSON parsing failure, and then tries a breadcrumb. This fallback chain can
  hide a changed page contract.
- Lua, Yaksha, and Scythe use an empty series title when the expected markup is
  absent. Missing metadata should be reported explicitly rather than accepted
  as a valid empty title.

These do not currently provide alternate chapter-image sources, so they are
less urgent than the Dave/Cubari behavior.

## Implicit source selection

- Scythe and Violet read `ts_reader` and always select `sources[0]`. Verify what
  multiple entries mean on each site. If the first entry is the site's defined
  canonical source, document that invariant; otherwise choose an explicit
  policy rather than depending on array order.

Scanning multiple script elements to locate the single `ts_reader` payload is
document discovery, not a content fallback.

## Valir chapter-list heuristic

Valir chapter images now use one RSC page-record contract. Its chapter-list
parser still searches only a bounded 100,000-character region around
`allChapters` and silently deduplicates results. A sufficiently large or
changed payload could omit chapters or conceal duplicate records. Replace this
with an exact payload boundary/parser if the chapter list becomes unreliable.

## Currently aligned for chapter images

- Asura: one chapter API.
- EzManga and QiScans: one Angular chapter API.
- Lua and Yaksha: one expected HTML image pattern each.
- Scythe and Violet: one `ts_reader` payload each, subject to the `sources[0]`
  question above.
- Valir: one RSC page-record contract.

The shared reader's retries of the same image URL and its ability to continue
showing the current chapter when chapter-list loading fails are recovery and
graceful degradation, respectively. They do not substitute another provider
data source.

## Suggested investigation order

1. Inspect real Dave/Cubari chapters with one and multiple groups.
2. Verify the semantics of `ts_reader.sources` on Scythe and Violet.
3. Make title extraction strict for Violet, Lua, Yaksha, and Scythe.
4. Replace Valir's bounded chapter-list scan if it causes an observed problem.
