# notes

The six provider apps are the only products: native UIKit apps in `apps/ios`
(read `apps/ios/DEVELOPMENT.md`, then `apps/ios/PAID-NATIVE.md` to deploy). The
web version they replaced is in Git history (before October 12, 2026).

## Sites supported
[providers.json](apps/ios/providers.json)

## Manual PC Load / Save

Home shows **Load** and **Save** at the end of the list when the PC is available.
Save replaces the shared PC reading state; Load replaces local reading state with
that save, even if older. No timestamp merging, automatic backup or periodic
imports. Offline PC hides the controls. The first explicit Save creates the shared
state. One canonical snapshot per provider, with the previous save retained for
recovery; see [server operations](server/BACKUPS.md). The app reads the PC's
address and key from the ignored `apps/ios/Resources/Native/BackupConfig.json`:
built app bundles contain the key, never publish them.

## Downloads

Each started manga keeps its current and next chapter on the phone (the previous
one is no longer kept); when the current chapter is finished, the next one comes
first. The chapter being read comes before everything, from the page on screen;
then the most recently read manga; then every catalog cover. A new chapter is
noticed as soon as Home's catalog or a chapter list shows it (both are refreshed
in the background, on return to the app, and by iOS's background app refresh), and
its pages download at once. Unfinished files go to iOS's background download
session when the app leaves the screen. Chapters outside a window are deleted once
no reader holds them; reading progress and saved chapter page lists stay. There is
no server history, tracking or provider authentication. Both reader ends have half
a screen of space.

## Covers

Every catalog cover stays on the phone. A cover on screen that has not been asked about for
six hours is asked about again, lazily and one at a time: a conditional request with its
validators (ETag, Last-Modified, kept in `covers/<file>.check`; a cover from before these
were kept uses its file's date), which all six sites answer with 304 and no bytes when the
cover did not change. Only new bytes replace the file, and the card shows them in place.

## Kill robustness

Every change (a settled page, the catalog, the screen stack, a finished image) is
written atomically when it happens. A relaunch rebuilds the screens and returns to
the exact point, and so does reopening a series from Home at the page it was left on
(going back, then tapping its cover). The first frame after a relaunch is already the
screen as it was left: covers and pages on the phone are decoded before it (NativeKit's
restore mode), the reader lays out its saved chapter at once, and the screens below are
built while the top one shows, so going back finds them complete. NativeKit's
`scripts/restore-check` (fast, coded) and `restore-video.sh` (slow, visual) show it: page sizes are known before a chapter is laid out (from the site,
or recorded from the images themselves), so nothing moves while images load.
