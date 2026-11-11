The coding agent owns this repository: any file may be changed, including this one, README.md and test.txt.

Start here:
- [README.md](README.md): what the apps are for, and a map of the docs.
- [apps/ios/README.md](apps/ios/README.md): the apps as they are, the rules not to break, and how to build, deploy, test and inspect them.
- [NativeKit guide](../../ios-tools/native/README.md): the shared Swift package vendored as `apps/ios/Kit` (modules, vendoring, main-thread and relaunch rules, FrameMonitor, simulator limits).
- [Mac and phone access](../../../environment/mac-access.md): `ssh mac`, UDIDs, signing.
- [Renewal](../../ios-tools/renewal/README.md): the monthly renewal of the paid-signed apps.

Docs describe the apps as they are now; history stays in Git. Update them with the change that makes them stale.

The viewer follows the user directly: free continuous scrolling, content loading in place,
and pinch zoom of the same content. Never add snapping, automatic centering, page landing,
runways or repositioning when scrolling stops. Loading, refreshes and player reuse preserve
the visible position. Cached next chapters must append during continuous scrolling; do not
require a scroll-end or settled-page check. Explicit navigation and restoration are separate.

The manga page cache downloads only current and immediate next chapters for
series the owner has touched. Untouched series get covers only. Previously
downloaded pages outside current/next expire 24 hours after leaving that pair;
the deadline survives relaunch/reboot and is never extended by replanning.
Open readers do not pin all their previous chapters indefinitely. Covers,
progress, positions and chapter metadata are preserved. On migration, remove
erroneous untouched-series page downloads immediately; existing touched-series
history gets the same one-time 24-hour grace. Do not download retired chapters.

The owner's preparation flow is explicit:

- On Home, refresh chapter state for all touched series and prepare metadata and
  image bytes for their saved current chapter and immediate next. A completed
  current chapter remains the resume target at its last page, with next ready.
- On opening a reader, raise that reader's work ahead of other entries: the
  current image is highest priority, then all remaining current-chapter images,
  then the immediate next chapter (metadata and images).
- Only after this reader's current/next work is ready should preparation of the
  other entries use the background slots. Existing cached work is reused.
- Read the exact image dimensions from available metadata/image headers before
  publishing its page box. Reserve the exact geometry first, then fill that box
  with decoded pixels. Image arrival must not stretch the page or resize already
  published reading content. Unknown dimensions are not an estimated page size.

No content work may wait for scrolling to stop, a finger to lift, or a settled-page
callback. Home updates, image loading, preparation and chapter appends run while
scrolling. Scroll-end callbacks only persist progress and record performance.

Delivery order: push the app updates first, then run virtual-iPhone UI checks.
If those checks require a fix, push the correction before the next simulation.
Native compilation/signing and model checks still apply; simulator trouble must
not hold back a deliverable update for the owner to try. Use the existing durable
queue and guards. Never substitute physical-phone UI automation.

Efficiency is a product requirement. File completions update their dependants and
advance existing queues; they never rebuild the whole catalog plan. Movement
within a chapter updates only that reader's priority. Cache known missing files,
advance the download queue with a cursor, and retain useful manifest entries
within a bounded memory budget instead of flushing the entire cache. Verify
work counts and CPU time with a large-library fixture, alongside responsiveness.

All manga cover bytes download proactively and remain on disk permanently,
independent of current/next chapter pruning. Visible covers decode first, then
covers ahead in catalog order as the bounded decoded cache permits. Do not
decode and immediately evict unseen covers in an unbounded warming loop.

Build speed depends on the module split (apps/ios/README.md, "Modules"). Code that does not
need UIKit lives in the `apps/ios/Core` package modules (`MangaSources`, `MangaLibrary`); the
app target holds only the screens. Do not move code back into the app target, merge modules or
add imports in the other direction. What crosses modules is `public`, with explicit
`public init`s. Split a module that grows past about 2,000 lines.
