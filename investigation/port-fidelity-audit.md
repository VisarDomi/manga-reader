# Port fidelity audit — September 13, 2026

Scope: four codebases, in this order: Manga Reader (six providers), Gallery
Reader (Hitomi/Imhen), Ytb, Stream Viewer (Tango, with the existing Xvid Safari
payload). Gallery Downloader is explicitly excluded. AGENTS.md is user-owned;
audit and operational notes belong here or in each app's PORT.md.

The userscript is the behavioral specification. App-specific changes already
requested by the user remain: native document navigation/cold restoration,
Manga's First chapter link and current-plus-next offline window, intentional
Manga PC Load/Save, provider-specific identities, and Tango's native auth/media
transport. These are not permission to redesign the UI or import unrelated
offline behavior.

## Manga Reader — first pass

Compared `src/routes/home.ts`, `src/routes/reader.ts`, the six provider adapters,
`src/core/compute/history.ts`, progress/backup, image retry and scroll settling
with the shared native web UI and Swift provider/storage adapters.

Confirmed corrections:

- Home previously combined cumulative native history with numeric chapter
  comparisons. A visited current chapter could be both read and partial; after
  going backward, later visited chapters remained read. The app now bundles
  the actual userscript `resolveHistory` function. Native storage is translated
  into its input model; no second read/partial policy remains.
- Reader navigation previously came from `Manifest.chapters`, retained on disk
  indefinitely. Non-Asura providers additionally required a successful chapter
  list fetch before showing any current pages. Current pages now open separately
  from a fresh `chapters` request, as in the userscript. A failed list displays
  the source error while keeping current images readable. Existing offline
  chapter-list fallback and the requested image cache remain. Old embedded lists
  are ignored, and new manifests do not populate them.
- Lua and Yaksha Home labels were reconstructed from chapter numbers. Native
  catalog models now retain their source labels. Lua's missing-index fallback
  reads the chapter name, matching `lua-catalog.ts`, rather than the route slug.
- Asura omitted the source's `-400.webp` cover variant. The adapter now applies
  the same URL transformation. Native cover bytes are keyed by the supplied
  cover URL, so a changed source cover no longer reuses the old slug-only file.

Validation: all six provider browser fixtures pass, including empty history,
backward reading, exact cover/cold-reader restore, user input, current+next
continuation, optional/manual PC actions, ignored embedded chapter lists and
chapter-list failure with decoded current images. Running the enhanced fixture
against HEAD's old web assets fails the read/partial exclusivity assertion.
The earlier navigation-only run also failed continuation because the old app
ignores the fresh list. The shared 34 unit tests and builder/signing-lock tests pass. Swift tests
on the Mac pass cache/prune/history/offline/checkpoint/provider/label/backup
checks. These are deterministic regressions, not physical gesture measurements.

## Manga Reader — catalog/order corrections

The remaining confirmed differences are now corrected in the same shared app:

- Each provider publishes catalog pages as they arrive, with the userscript's
  one-second delay between pages and its actual shared loaded-count/status and
  time-label helpers. Native Home keeps not-yet-refetched cached rows available
  during loading, as required for immediate app restoration. Completed refreshes
  remove absent rows; later failures preserve already published rows and show
  the failure. Unchanged cards/images retain their DOM nodes. Catalog updates
  neither wait for a scroll timer nor forcibly reset the user's scroll position.
- Chapter adjacency follows each provider's supplied order. The native internal
  oldest-first representation reverses the source list without numerical sorting
  or generic deduplication. Scythe retains its source's explicit ID deduplication;
  Lua retains the source's explicit Home-only sort. First, Next and current-plus-
  next prefetch therefore agree even when numeric order differs from source order.
- Repeated series on later catalog pages merge unseen chapter IDs into the first
  row, up to the source's five chapters, preserving original metadata and order.
  Invalid duplicate/missing-current reader lists fail visibly while current
  images remain readable.
- Live Asura testing exposed a missing-field edge case: the API omits `has_more`
  on its last page. Pagination now stops unless that flag is true, like the
  userscript, instead of fetching an extra empty response.

The expanded six-provider browser fixtures verify immediate batch publication,
unchanged card/image identity, loading/completion status, provider-defined
First/Next order and malformed-list handling. Native Swift fixtures cover batch
callbacks before subsequent requests, omitted final-page `has_more`, five-slot
merge behavior, metadata retention, provider adjacency and partial failure.
The shared unit/build checks also pass. All six live providers pass catalog, full chapter list, reader manifest and image
transfer checks. Physical Asura inspection captured fresh counts 50 through 345,
then completion without an error. All six signed apps were rebuilt and installed;
the monthly runner renewed their approved inputs successfully. Detailed results
are recorded in the verification artifact; fixtures are not smoothness measurements.
Authenticated Asura remote history is not exercised by these public-provider tests.

## Gallery Reader — first pass

The prior build-8 correction removed persistent resolved image URLs and the
indefinite metadata fallback, and reused the source image retry registry.
The additional pass compares online.ts/gallery-app.js with source Home/Search,
paginated-grid, gallery-row, reader, providers, actions and scroll settling.

- Home incorrectly called getReaderData/imageUrls to build thumbnail rows.
  It now calls only the shared getGalleryThumbnails/thumbnail URL path, like
  paginated-grid. Reader page resolution no longer depends on thumbnail requests.
- The inherited shell saved positions every 150ms during scrolling. It now uses
  the source onSettledScroll directly. Native lifecycle checkpoints and a
  horizontal strip's own scrollend remain; no timer runs during reader scrolling.
- A pagination click now scrolls the grid into view after rendering, as in the
  userscript.

Both provider fixtures pass search, favorites/info, current image routing,
actual decoding, retry recovery, Back, cold restore and offline-PC behavior.
A new fixture assertion rejects any Hitomi gg.js request while only Home/search
thumbnails are being rendered. Another checks no checkpoint during an ongoing
scroll and immediate checkpoint at scrollend. TypeScript checks pass.

The native slot activation/release and fractional cold restoration are the
explicitly accepted Gallery-style app mechanics. The shell still duplicates
parts of the grid/CSS; this pass is not a pixel-by-pixel equivalence claim.

## Ytb — first pass

Reviewed build.mjs's checked source substitutions, app/native/fetch/storage
adapters and native checkpoint/navigation handling. The build imports the actual
userscript favorites/listing/actor/video routes, provider, controls, favorites,
backup and CSS. App-specific substitutions are SOC removal, local navigation,
clipboard bridge, the requested Ytb namespace and native lifecycle restoration.
No new demonstrated runtime mismatch in the checked flows; no runtime change.

The existing browser suite passes manual import, silent offline PC, native
storage isolation, inline muted autoplay, original controls, Copy on media
failure only after a tap, related-video replace plus single Back, cold restore
and worker recreation after Back. Codec support is not expanded or claimed.

## Stream Viewer — first pass

Reviewed the required-provider builder, shared start/home/stream/provider paths,
native request adapter, checkpoint/foreground adapters and native auth boundary.
UI, Multi, selection, Follow/Unfollow/Block remain shared source. Native auth and
in-process HLS transport are the tested, necessary app boundary. The preceding
build-8 Content-Type correction is retained; no further runtime change here.

The app browser suite and TypeScript checks pass. Tests include fresh cold lists,
streamer reanchoring, Back, stale-save rejection, Multi and targeted action flows.
They use fixture accounts; this audit did not repeat real Follow/Block mutations.
The prior real-account test restored Block/Follow state and is documented in
Stream Viewer's follow-verification.json. Xvid's hosted Safari payload remains
byte-identical (fb73c7754f18fb24b76a3cb2014807a9ce569cef2a7b68606a07365c14725142).

## Delivery

Provider build/install and renewal verification are recorded separately in
`port-fidelity-verification.json`. Existing app identities and user data are
retained. No user-owned readme, test.txt or AGENTS.md edits are part of this audit.
