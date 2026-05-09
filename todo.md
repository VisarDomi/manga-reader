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

2. [pending] Remove broad search-result derived work used only for prewarm.
   - `MangaList` builds a full joined ID string from every manga on each result
     change.
   - Replace it with an explicit list-version or append signal owned by the
     search/list owner.

3. [pending] Keep mounted cards cheap while offscreen.
   - Search results can intentionally keep 1000+ cards mounted.
   - Add a non-behavior-changing rendering optimization such as
     `content-visibility: auto` with stable intrinsic card sizing so offscreen
     cards stay mounted but avoid unnecessary layout/paint cost.

4. [pending] Add targeted list-prewarm performance logs.
   - Log card/result count, sampled/visible count, and scan duration.
   - The log should prove whether list prewarm still spends frame budget during
     large-result stress tests.
