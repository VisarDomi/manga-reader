# Asura Reader iOS app

One native application target, fixed bundle ID `com.visar.AsuraReader`.
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
