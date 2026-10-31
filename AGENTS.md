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

The manga page cache intentionally retains current and next chapters, plus chapters held
by open readers. Preserve that policy; the owner explicitly declined keeping every download.
