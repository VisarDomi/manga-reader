For extension deployment or real iPhone Safari investigations, start with
`investigation/iphone-extension-debugging.md` (Hackintosh SSH, Xcode signing,
native inspection, and physical gesture capture). Update that runbook as steps
are verified; keep runtime behavior in this repo and packaging in reader-extensions.

## more notes

An iOS Safari extension inside **Reader Extensions**, also buildable as a
userscript. See [extension setup and validation](extension/README.md).

## Sites supported
[sites.ts](src/core/sites.ts)

## Manual PC Load / Save

Home shows **Load** and **Save** beneath the loaded-series text when the PC is
available. Save replaces the shared PC reading state; Load replaces local reading
state with that save, even if older. No timestamp merging, automatic home backup,
progress publisher, or periodic app imports. Discovery checks availability only.
Offline PC hides the controls. First explicit Save creates the shared state;
older automatic backups remain on disk without being silently selected.

One canonical snapshot per provider, with the previous save retained for recovery.
Load validates first and replaces IndexedDB atomically; sessions stay local.
The app preserves fractional progress/history in compatible metadata. See
[manual PC details](apps/ios/DEVELOPMENT.md) and
[server operations](../gallery-downloader/ASURA-MANUAL-STATE.md).
Builds read the sibling server's private key automatically; see [.env.example](.env.example).
Do not publish built userscripts or extension bundles containing that key.
Database/network work remains in the compute worker.

## [Testing](test.md)
See the [Linux → Hackintosh → real iPhone debugging runbook](investigation/iphone-extension-debugging.md)
for verified SSH options, Xcode deployment, native inspection, and gesture capture.
For the installed extension, use native Safari inspection and normal taps/swipe
Back. The optional userscript harness (`npm run tests`) injects a build; disable
the extension before using that harness so two versions cannot compete.

## September 16: Asura resume and sliding downloads

Build 5 separates Asura's stable file identity from its rotating navigation
slug. Reusing chapter 61's old route alongside cached 62's new route caused
Magic Tower's cover continuation failure. Manifest returns now use the requested
route without changing downloaded files.

The user changed the download requirement: previous + current + next per manga,
prepared on Home and moved/pruned while reading. Keep local history and other
manga's windows. Server history/tracking/auth refresh are removed in every
runtime. Manual PC Load/Save remains. Both reader ends now use 50svh padding.
See `investigation/asura-resume-download-window.md` and its verification receipt.
