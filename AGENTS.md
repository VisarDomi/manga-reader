# Manga Reader

Agent owns all repo files. Read README.md and apps/ios/README.md; shared iOS rules:
../../ios-tools/native/README.md; access: ../../../environment/mac-access.md;
renewal: ../../ios-tools/renewal/README.md. Update current docs with code; history in Git.

- Free continuous scroll/pinch; loading, refresh/reuse and cached chapter appends
  preserve position while scrolling. No snapping, centering, runways or scroll-end
  gates. Explicit navigation/restoration are separate. Scroll-end only saves progress
  and performance; no content work waits for finger lift/settling.
- Pages: touched series' current + immediate next only; untouched series get covers.
  Outside that pair, expire pages24h after departure; persist deadlines across reboot,
  never extend on replans or pin past chapters through open readers. Preserve covers,
  progress, positions and metadata. Migration removes erroneous untouched pages
  immediately; touched history gets one24h grace. Never download retired chapters.
- Home refreshes all touched chapter states and prepares saved current/next metadata
  and bytes. Completed current resumes at its last page. Opening a reader prioritizes
  current image → remaining current images → next chapter → other entries; reuse cache.
- Publish exact dimensions from metadata/headers before page boxes; then fill pixels.
  Unknown dimensions are not estimates. Keep geometry and bounded auto-retries on
  load/decode failure; never move/remove a page to hide errors.
- All cover bytes download proactively and persist permanently. Decode visible,
  then ahead in catalog order within a bounded cache; no decode/evict warming loops.
- Completions advance dependants/queues, not whole-catalog replans. Intra-chapter
  movement changes only reader priority. Cache missing-file knowledge, use queue
  cursors and bounded useful manifests. Check large-library work counts/CPU and UI.
- Compile/model-check, push through the durable guarded queue, then virtual-iPhone
  QA; push fixes before the next simulation. Simulator trouble cannot block a
  deliverable update or authorize physical-phone UI automation.
- Investigate source/history/installed behavior first. Children inherit these cache,
  geometry, position, device and delivery constraints. Resolve cross-reader ambiguity;
  preserve provider data and conditional revisit limits.
- Build speed: keep the module split (apps/ios/README.md "Modules"). Non-UI code goes in the
  apps/ios/Core modules (MangaSources, MangaLibrary), never back into the app target; no
  merging modules or reverse imports. Cross-module API is public with explicit inits; split a
  module past ~3,000 lines.
