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
promotes an existing queued request; it never starts a duplicate transfer. Files
become readable individually, without waiting for an entire chapter. Native
`asura://app/image` serves these files; the reader never fetches image URLs itself.

The shared reader still uses its normal lazy image elements. This controls local
loading/decoding/display, **not network preparation**: all images in the retained
chapters are downloaded independently of scrolling. Do not introduce a second
IntersectionObserver, image queue, DOM-window removal or app-specific retries.
Downloads pause in the background and resume on foreground.

## Native-only additions

- First chapter link per Home card.
- Cold Home/reader/position restoration and WebKit back-swipe navigation.
- Previous/current/next file retention and preparation described above.
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
node apps/ios/Tests/browser.mjs
```

The browser suite builds all six bundles and exercises source reader/tracking,
whole-chapter preparation without scrolling, native image URLs and Lua's mixed
`src`/`data-src` extraction. On the Mac run `swift run ReaderCoreTests` from the
native mirror to test the real downloader: bounded jobs, promotion, deduplication,
file reuse, pruning, pause/resume and preservation of history. These checks do not
establish physical scroll smoothness; inspect the installed app and test gestures
on the phone. The shared-refactor investigation records physical delivery checks.
