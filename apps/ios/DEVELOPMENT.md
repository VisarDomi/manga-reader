# Provider reader iOS apps

AsuraReader (`com.visar.AsuraReader`) and ScytheReader (`com.visar.ScytheReader`)
are targets sharing the same Swift runtime, web resources, and reader UI.
The target sets `ReaderProvider` in Info.plist; `ReaderSource` supplies catalog,
chapters, manifest, and image transfers. Asura parses its API; Scythe mirrors
`src/provider/scythe.ts` using native SwiftSoup HTML parsing on its actor.
Scythe preserves complete chapter URLs (including collision suffixes) separately
from displayed chapter numbers. Its backup provider is `scythescans`, with
`scythe-ios-v1` fractional history metadata. Asura state paths/keys stay compatible.
Both apps keep the private `asura://app/` web bridge for compatibility; this is
only an internal origin, not a network provider or shared storage container.
Bundled WKWebView reader; Swift actors own storage/networking. No Asura page
scripts, extension targets, or SOC. Do not reuse another app's ID or data container.

## Product contract and source parity

Use manga-reader's userscript as the behavior/UI reference. `scripts/prepare-web.mjs`
(runs during deploy sync) copies `src/style.css` and compiles the actual
`src/core/scroll-settle.ts` and `image-retry.ts` into bundled `reader-core.js`.
Keep the userscript's 150×200 covers, chapter rows/read colors, midpoint progress,
100ms touch-aware settling, retry policy, continuous next chapter, full-width
images, 50svh top and 100svh bottom reader padding. No custom toolbar, header,
search, titles, download badges, or All chapters controls.

User-authorized additions/differences:

- First chapter link on every Home card.
- Native files/networking and bounded visible-first image sources from Gallery's
  shell. Home prepares the current/last-read/partial chapter plus its immediate
  next chapter per started series, never all future chapters or previous chapters.
- Opening an uncached chapter loads on demand. Home prunes obsolete image files
  while retaining reading history/progress. Going backward changes current.
- Resume the app's previous screen and fractional image position. Cover resumes
  the current reading position. User input cancels an unfinished restore.
- Explicit Load/Save below Home's loaded-series text. Hidden when PC unavailable.

Asura can omit every image dimension: chapter
`the-extras-academy-survival-guide-53fc8424/123` has 28 such pages. Accept them like
the userscript; use provisional 1000px slots, then natural dimensions. Native
ImageIO saves dimensions from completed files without raster decoding so cached
restores have stable geometry. Resolve preceding unknown dimensions before an
uncached restore jump. Do not reintroduce the rejected dimension validation.

## Manual PC reading state — replaces the automatic pipeline

The previous extension publisher, app foreground/30s polling, automatic named
backups, enrollment UI, and timestamp-merging imports have been removed.
The userscript and extension use the same worker commands. Native app uses the
same canonical PC snapshot format and endpoint.

- Home/foreground checks only authenticated `/status` availability. No reading
  data is downloaded/uploaded by discovery. Missing PC hides both controls.
- Save deliberately replaces the PC snapshot with this device's local reading
  state, even when older, backward, or empty. No automatic retries or merges.
- Load deliberately replaces local reading progress/history with the PC snapshot,
  irrespective of timestamps. Sessions remain local. Invalid/failed loads leave
  local state intact. Missing PC during a click hides the controls silently.
- An available PC with no save reports that fact when Load is pressed. The first
  explicit Save creates the shared state. Old automatic backups are retained on
  disk but are not silently chosen or imported.

Endpoint prefix: `/api/reader-backups/manual/manga-reader/<provider>`.
GET `/status` returns availability only; GET the prefix loads; PUT saves.
Asura app uses provider `asurascans`. Same existing `X-Reader-Backup-Key` auth,
Asura origin CORS, no-store responses, and bundled public LAN CA trust.
Format is manga-reader's v1 IndexedDB backup (progress schema 3); `asura-ios-v1`
metadata retains app reading history/fraction through a userscript round trip.
The standard progress row remains authoritative if it changed after that metadata.

PC file: sibling `gallery-downloader/backups/readers/manual-manga-asurascans.json`.
One atomic private file retains `current`, `previous`, and `savedAt`; no merged
feed. The obsolete `/library/asurascans` endpoint returns 410 so old publishers
cannot recreate the automatic pipeline. Older named backup files are preserved.
Server implementation: `gallery-server/downloader/src/manual-manga-state.ts` and
`reader-backups.ts`. Other reader apps and Gallery's native WIP are untouched.

## Private local configuration

`AsuraReader/` contains Swift runtime; `Resources/Web/` contains the bundled UI.
Optional ignored `Resources/Native/BackupConfig.json`:

```json
{"url":"https://YOUR-PC:7777","key":"YOUR-READER-BACKUP-KEY"}
```

Copy the PC's public CA to ignored `Resources/Native/LocalCA.cer`. Native TLS
trusts it only for the configured PC host with hostname/certificate checks.
No private key or backup credentials in logs or JavaScript. Local state has iOS
file protection. Missing configuration simply hides the PC controls.

## Hackintosh build and physical phone

Start with `../../investigation/iphone-extension-debugging.md` for trusted SSH,
Mac/iPhone identifiers, GUI signing, and inspector caveats. App mirror:
`/Users/visar/Developer/asura-reader`, separate from the other apps.
Copy trusted connection fields from existing Reader Extensions deploy config to
ignored `apps/ios/deploy.local.json`: host, knownHosts, guiUid, signingTeam, device.

```sh
python3 apps/ios/scripts/deploy.py sync
python3 apps/ios/scripts/deploy.py build
python3 apps/ios/scripts/deploy.py status
# Require no PID, LastExitStatus=0, and BUILD SUCCEEDED.
python3 apps/ios/scripts/deploy.py check
python3 apps/ios/scripts/deploy.py install
python3 apps/ios/scripts/deploy.py finish
python3 apps/ios/scripts/deploy.py launch
```

Signing uses GUI LaunchAgent `com.visar.asura-reader-build` and the existing
Apple Development identity. Install verifies bundle ID, signature, bundled web
and optional native configuration hashes. No new app IDs. Like Gallery Reader, the app declares no custom icon and
contains no icon assets or asset catalog. No simulator needed.
Do not overlap app and Reader Extensions builds. Reader Extensions renewal stays
paused from the earlier experimental pure-SOC trial; do not resume it implicitly.

## Verification

Mac mirror `bash scripts/test.sh`: Swift 6 tests for cache policy, pruning/history,
backup format, explicit replacement including older/empty state, offline files,
cold restart, shared downloads, and unavailable PC. Linux
`node apps/ios/Tests/browser.mjs`: real bundled UI, all page metadata sizes absent,
cover fraction/manual scroll/First/next, bounded images, Load/Save only on click,
controls beneath loaded text, and hidden when PC is absent. Main repository
`npm run test:unit` also tests manual worker and userscript controls. PC server:
`npm run build && node --test dist/reader-backups.test.js dist/manual-manga-state.test.js`.

App inspector Python:
`/Users/visar/Developer/gallery-reader-extension/inspector-venv/bin/python`.
Run mirror `scripts/app-inspector.py` with that Python, optional `--evaluate-file`,
`--seconds 0..30`, and `--screenshot`. Selects only com.visar.AsuraReader and
asura://app/. Keep phone unlocked/app foregrounded, only one collector at a time.
After navigation attach a new collector once the old one exits: navigation can
invalidate the old target. Do not name the script inspect.py (stdlib collision).

2026-09-11: installed reader fix physically opened chapter 123 with all 28 slots,
real loaded 1200×800 and 900×16000 images, no errors, and only reader-core.js/app.js.
Home had 343 cards. Browser/native checks establish behavior, not subjective
physical scroll smoothness. Old 30-entry automatic pipeline verification is
historical; the current product uses explicit Load/Save only.

## Reader restart uses Gallery's position lifecycle

Reference implementations: sibling Gallery's `Resources/native.js`,
`gallery-server/downloader/public/offline/app.js` position helpers, and native
`view-save` handler. On cold launch the intermediate Home document sets
`skipPositionSave` while redirecting to the saved reader. Back navigation clears
that flag when the retained Home document initializes again. Never let bootstrap
Home overwrite the last reader checkpoint.

Restoration holds the logical image anchor, aligns immediately and on the next
animation frame/ResizeObserver layout changes, and releases it on user input,
matching Gallery's lifecycle. Asura keeps its existing top-relative fractions
for compatibility with saved bookmarks. A single native view-save atomically
writes screen, fractional position, and reading progress; there is no second
JS-to-native round trip required before suspension.

Tests cover a lifecycle checkpoint requested while the bootstrap Home renders,
exact fractional cold restart, and native persistence of the complete checkpoint.

## LiveContainer guest builds (Asura and Scythe)

See [LC setup](../livecontainer/SETUP.md) for the host, certificate, and renewal.
Gallery Reader remains a normal installed app. Reader Extensions was reinstalled
as a normal app named **Reader Extensions**, preserving its existing bundle ID.

Sync shared sources from Linux as above, then on the Mac:

```sh
cd /Users/visar/Developer/asura-reader
python3 scripts/build-guest.py scythe
# Also accepts asura. No Apple provisioning/account registration for guests.
python3 /Users/visar/Developer/livecontainer/scripts/deploy.py import-app /Users/visar/Developer/asura-reader/build/Release-iphoneos/ScytheReader.app
```

The guest builder shares the existing Mac signing lock. Do not bypass an active
build/signing job. Import uses LC's own installer; a replacement confirmation or
first-run permission may require the phone owner. Never call the native `install`
action for a guest or uninstall LC to update a guest.

SwiftSoup is pinned to 2.11.3 revision `0a1cd58aec8774d4110b2ceb8971061eac964efd`.
Xcode resolves its package automatically, with no manual project setup. Native
`bash scripts/test.sh` uses SwiftPM with the same revision. Set `READER_LIVE_CHECK=1`
for a read-only live Scythe catalog/chapter/image check (the temporary image is
removed by the test). `node apps/ios/Tests/browser.mjs` runs the identical UI
contract against Asura numeric IDs and Scythe IDs with collision suffixes.
No site JavaScript executes in the app; SwiftSoup parses fetched HTML as data.


2026-09-11 Scythe delivery: normal LC import and device launch passed. Native
Home had 63 cards; Magic Emperor chapter 907 opened 7 pages with real loaded
800×9605 images and no errors. A programmatically saved y=1200 restored exactly
after terminating LC and relaunching Scythe. Both provider browser suites passed;
native cache/backup/Scythe parsing tests and live HTTP checks passed. This verifies
functional restoration, not the user's physical scroll feel. The existing Asura
guest was preserved and separately verified after the LC helper update; its
shared-source refactor is tested locally but has not replaced that guest yet.
