# Search Result Stress TODO

## Goal

Reduce main-thread pressure when search has 1000+ mounted results, without
changing navigation behavior or hibernating top-level views.

## Plan

1. [completed] Make list visible-prewarm inspect only the visible area.
   - `MangaList` currently scans every mounted card with `querySelectorAll` and
     `getBoundingClientRect()`.
   - Replace the full-card scan with viewport sampling so cost is bounded by
     visible rows, not total search result count.

2. [completed] Remove broad search-result derived work used only for prewarm.
   - `MangaList` builds a full joined ID string from every manga on each result
     change.
   - Replace it with an explicit list-version or append signal owned by the
     search/list owner.

3. [removed] Keep mounted cards cheap while offscreen.
   - Search results can intentionally keep 1000+ cards mounted.
   - `content-visibility: auto` did not improve the measured heavy-search
     reader gaps and carries browser rendering behavior risk, so leave it out.

4. [completed] Add targeted list-prewarm performance logs.
   - Log card/result count, sampled/visible count, and scan duration.
   - The log should prove whether list prewarm still spends frame budget during
     large-result stress tests.
