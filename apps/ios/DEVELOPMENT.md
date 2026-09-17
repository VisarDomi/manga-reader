# Manga Reader provider apps

The userscript, Safari extension and iOS apps run the same implementation from
`src/`: provider extraction, Home, reader, styles, history, progress, image retry,
scroll settling and explicit PC Load/Save. Do not copy these into Swift or a
second app UI. `apps/ios/web/app.ts` imports the source routes directly.

## Build one provider

From the repository root:

```sh
npm run build:ios -- lua --prepare-only
python3 apps/ios/scripts/deploy.py sync lua
python3 apps/ios/scripts/deploy.py build lua
python3 apps/ios/scripts/deploy.py install lua
```

Replace `lua` with `asura`, `scythe`, `yaksha`, `qiscans` or `ezmanga`. A provider
is mandatory; identities and names come from `src/core/sites.json`. All six apps
have independent containers and retain their existing paid bundle identifiers,
names and absence of icons. No Swift provider adapters or SwiftSoup dependency
remain. See [paid signing](PAID-NATIVE.md) for Mac/iPhone configuration.

`prepare-web.mjs` bundles the selected source provider, source routes/CSS and
source compute worker. Its aliases replace only native boundaries: HTTP, durable
storage, local navigation, document creation, and the platform hooks. Generated
assets live in `build/<provider>/Web`; they are not source files. `build-guest.py`
stages that provider's assets into `Resources/Web` **inside the signing lock**.
Never edit or commit generated Web assets. Without the paid deploy command,
`npm run build:ios -- <provider>` still builds an unsigned LiveContainer guest.

The Mac build runs attached in the existing GUI login using `launchctl asuser`
and `caffeinate -i`. It registers no LaunchAgent/background item. Existing monthly
renewal configurations fingerprint `build/<provider>/Web`, not the shared staging
folder, so building another provider cannot invalidate the approved app.

## Image ownership

The selected JS provider determines the exact image URLs and order. The app's
JS coordinator requests previous/current/next in provider chapter-list order.
It starts current metadata independently of the chapter list and other manga;
metadata and image concurrency are bounded. Home prepares every saved current
position without waiting for catalog pagination. While reading, changing current
moves the retained window. Obsolete images/metadata are deleted; history remains.

`ImageDownloader` is the sole image network/cache owner. Background preparation
and visible WebKit image requests use the same job and local file. Visible work
promotes an existing queued request and cancels/requeues unrelated background
transfers while foreground images are pending; it never starts a duplicate
transfer for the same image. Cached-file checks run in bounded yielding batches,
and pruning no longer blocks chapter/bootstrap responses. Metadata has a separate
URLSession connection pool from images. Foreground chapter lists also promote
queued background metadata. Files
become readable individually, without waiting for an entire chapter. Native
`asura://app/image` serves these files; the reader never fetches image URLs itself.

The shared reader still uses its normal lazy image elements. This controls local
loading/decoding/display, **not network preparation**: all images in the retained
chapters are downloaded independently of scrolling. Do not introduce a second
IntersectionObserver, image queue, DOM-window removal or app-specific retries.
Downloads pause when iOS backgrounds the app and resume on foreground.

Every Home catalog page registers **all** its cover URLs with the downloader,
including offscreen rows. `shared/covers.json` retains those preparation targets
across app launches. Covers use the same local-file path and foreground-priority
policy as pages; Home rendering does not await their downloads.

Home still uses the actual userscript catalog flow: first response, then each
additional page in provider order. The shared loader buffers up to three known
upcoming pages concurrently, without a pagination timer, and pauses scheduling
while Home is hidden. Successful in-flight responses are retained for Back;
requests canceled by native navigation restart on return. QiScans, EzScans and
Asura expose known upcoming cursors from their API page counts. Providers with
only a next-page link remain sequential. Lua's source
requests its catalog in one response. Catalog metadata is live; this image
ownership change does not introduce a separate cached catalog or copied Home UI.

## Native-only additions

- First chapter link per Home card.
- Cold Home/reader/position restoration and WebKit back-swipe navigation.
- Previous/current/next file retention and all-cover preparation described above.
- Atomic native storage and HTTPS transport. The transport preserves the
  provider's real referrer; Fetch otherwise normalizes it against the local
  custom-scheme origin, which caused Lua API HTTP 403 during verification.

No server tracking, authenticated provider sessions, automatic PC history sync,
new reader controls or custom image error overlays are introduced. Source UI,
retry/error text, image ordering, 50svh reader padding and no-image-callout rules
are shared. PC Load/Save use the actual source worker/UI and are hidden when PC
is unavailable.

## History and delivery

No conversion/migration from the former Swift AppState is provided. Before the
first shared-code installation, press **Save** in each existing app and verify
**Saved**. After installing, press **Load** and verify **Loaded**. These are the
existing deliberate PC commands, not background sync. New native files are under
`Library/Application Support/<productName>/shared`; incomplete old manifests are
never imported. Later updates retain this shared storage normally.

After final installation, deliberately approve each delivered app in the existing
monthly renewal runner, run a real renewal, then restore that scheduler. Keep its
recovery copy in `/home/visar/Documents/environment/mac-renewal` updated. Do not
create extra daily jobs or background items.

## Verification

```sh
npx tsc -p apps/ios/tsconfig.json
npm run test:unit
npm run test:ios:builder
```

Runtime validation targets the physical iPhone and Safari/WebKit. All three
Chromium-only fixtures and the `test:extension` command were removed at the
user's request. Retain the unit, provider-builder and signing-lock checks above.
For Safari userscript flows use `npm run tests` / `npm run tests:single`; inspect
installed native provider apps with `scripts/app-inspector.py` on the Mac.
Verify reader images, whole-chapter preparation, Home/Back and cover resume on
the phone, including Lua's mixed `src`/`data-src` chapter images.

On the Mac run `swift run ReaderCoreTests` from the native mirror to test the
real downloader: bounded jobs, promotion, deduplication, file reuse, pruning,
pause/resume and preservation of history. These checks do not establish physical
scroll smoothness; test gestures on the phone. The shared-refactor investigation
records physical delivery checks.

## September 17: Back and download priority (build 8)

The bridge's document handshake now owns request cancellation and activation.
Do not clear that ownership in `didCommit`: on a cached Back navigation it can
run after reactivation and strand Home with “Document is no longer active.”
Queued worker calls wait for reactivation. Even an incompletely initialized
cached page must reactivate before resuming its pending initialization.
View checkpoints require an initialized, rendered route, preventing a reader URL
from being saved as Home during startup. The reader saves again once rendered.

Scythe reproduced the persistent empty Home before this correction and populated
40 then 63 rows afterward. All 63 cover files were present without scrolling.
See `investigation/2026-09-17-verification.json` for final delivery and checks.

## September 17: shared catalog pagination (build 9 / userscript 289)

`src/core/home-pages.ts` buffers at most three known upcoming pages and emits
them in provider order. QiScans/EzScans and Asura expose bounded cursor lookahead
from provider page counts. The first request is unchanged. No speculative page
numbers or separate native pagination are used. A paused Home retains successful
responses and resumes interrupted requests on Back. A killed process starts a
fresh catalog request; durable reading history and native view checkpoints remain.

Physical QiScans timing: first 50 rows at 744 ms, all 973 at 5,724 ms, versus
1,168 / 67,827 ms before. Maximum observed catalog concurrency was three. Killing
during a partially loaded catalog and restarting completed all rows again. Killing
in chapter 1 restored the same chapter/image, and Back completed Home with both
existing resume links intact. See `investigation/2026-09-17-pagination-verification.json`.
