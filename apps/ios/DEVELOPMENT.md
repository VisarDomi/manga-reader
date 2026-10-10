# Manga Reader provider apps

The six apps run the implementation in `src/`: provider extraction, Home, reader,
styles, history, progress, image retry, scroll settling and explicit PC Load/Save,
with the app's entry points and native bridge in `src/app/`. Do not copy these
into Swift or a second app UI.

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
have independent containers, their paid bundle identifiers and names, and no icons.
See [paid deployment](PAID-NATIVE.md) for Mac/iPhone configuration.

`prepare-web.mjs` bundles `src/app` with the selected provider
(`@selected-provider`) and the embedded compute worker; nothing else is swapped.
Generated assets live in `build/<provider>/Web`; they are not source files.
`build-guest.py` stages that provider's assets into `Resources/Web` **inside the
signing lock**. Never edit or commit generated Web assets.

The Mac build runs attached in the existing GUI login using `launchctl asuser`
and `caffeinate -i`. It registers no LaunchAgent or background item. Renewal
configurations fingerprint `build/<provider>/Web`, not the shared staging folder,
so building another provider cannot invalidate an approved app. This repository
renews its own apps with its Mac scheduler, `com.visar.renewal.manga-reader`
([ios-tools renewal](../../../../ios-tools/renewal/PAID-REFRESH.md)):
`scripts/renewal.py` lists every provider in `build/providers.json` (identity plus
`.paid`, inputs, builder), so a new provider needs no change outside this repository.
`deploy.py install` approves the installed build as that app's renewal baseline,
keeping its renewal date, when neither its inputs nor the app changed since
`deploy.py build`; otherwise it prints why approval was skipped. No scheduler pause
or forced renewal is needed.

## Image ownership

The selected JS provider determines the exact image URLs and order. The app's
JS coordinator requests previous/current/next in provider chapter-list order.
It starts current metadata independently of the chapter list and other manga;
metadata and image concurrency are bounded. Home prepares every saved current
position without waiting for catalog pagination. While reading, changing current
moves the retained window. Obsolete images/metadata are deleted; history remains.

Resuming must never wait for the network. Every fetched chapter list is saved
beside the chapter manifests (`["chapters", identity]`); background preparation
starts from it, and a reader continues from it at once, so the prepared next
chapter appends immediately. Both still ask the provider: a different answer
replaces the saved list and moves that series' window. Home rows (each series'
newest chapters) extend a kept list at once when the rest of the row continues it
exactly for two or more chapters (`src/core/chapter-list.ts`), so a chapter released
since the last visit is prepared before its slow list request returns; a reader never
lets a source's older cached answer drop a chapter it already knows. Readers re-check
the list while reading the newest listed chapter. Providers must keep list requests to
cached or fast endpoints; Scythe's uncached pages take up to 85 s (see
`investigation/2026-10-06-scythe-next-chapter.md`).

`ImageDownloader` is the sole image network/cache owner while the app is on screen (while it
is away, `BackgroundDownloads` finishes its unfinished files into the same cache; below). Background preparation
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
Prepared chapters keep downloading while the app is away (locked, in the background,
or closed by iOS; a force-quit from the app switcher stops them): when the app resigns
active, `BackgroundDownloads` hands the downloader's unfinished files (each series'
window in order, the current chapter first, then covers) to a background URLSession,
which writes the same cache files. Back on screen the remaining transfers are cancelled
and `ImageDownloader` carries on. Only already-prepared chapters can download this way;
preparing further chapters needs the page. Hand-off happens while the app is still
active because iOS defers transfers started from the background.

Lifecycle: resigning active only saves the position; a real trip to the background pauses
the page; only then does becoming active resume it. When iOS ends the web content process
in the background, the page reloads in place and restores its saved position for that
address (no cold start through Home).

Every Home catalog page registers **all** its cover URLs with the downloader,
including offscreen rows. `shared/covers.json` retains those preparation targets
across app launches. Covers use the same local-file path and foreground-priority
policy as pages; Home rendering does not await their downloads.

Home uses the shared catalog flow (`src/core/home-pages.ts`): first response, then
each additional page in provider order. The shared loader buffers up to three known
upcoming pages concurrently, without a pagination timer, and pauses scheduling
while Home is hidden. Successful in-flight responses are retained for Back;
requests canceled by native navigation restart on return. QiScans, EzScans and
Asura expose known upcoming cursors from their API page counts. Providers with
only a next-page link remain sequential. Lua shows its newest 100 series at once,
then its whole catalog from one response (its offset pages repeat and skip series
that share a sort key; an uncached 1000-series query takes ~5 s). Catalog metadata
is live; this image ownership change does not introduce a separate cached catalog
or copied Home UI.

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

## Bridge ownership

The bridge's document handshake owns request cancellation and activation. Do not
clear that ownership in `didCommit`: on a cached Back navigation it can run after
reactivation and strand Home with "Document is no longer active." Queued worker
calls wait for reactivation; an incompletely initialized cached page reactivates
before resuming its pending initialization. View checkpoints require an
initialized, rendered route, so a reader URL is never saved as Home during startup.

## Verification

```sh
npx tsc --noEmit -p apps/ios/tsconfig.json
npm run test:unit
npm run test:ios:builder
npm run test:server
```

Unit tests run the app code in jsdom with Asura as the selected provider. Inspect
installed apps on the Mac with ios-tools' inspector
(`~/Developer/ios-tools/inspector/app-inspector.py --url-prefix asura://app/
--snapshot-file scripts/inspector-snapshot.js`; see its README). Verify reader
images, whole-chapter preparation, Home/Back and cover resume on the phone,
including Lua's mixed `src`/`data-src` chapter images.

On the Mac run `swift run ReaderCoreTests` from the native mirror to test the
real downloader: bounded jobs, promotion, deduplication, file reuse, pruning,
pause/resume and preservation of history. These checks do not establish physical
scroll smoothness; test gestures on the phone.
