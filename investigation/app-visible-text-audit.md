# App-visible text and port fidelity audit — September 16, 2026

Reference: the current **userscript source**, not another native app and not an
old port audit. Scope: the six Manga Reader providers, Hitomi/Imhen, Ytb, Tango
and its Xvid extension. Gallery Downloader is included separately as an inventory
only: it is an intentionally different offline app and has unrelated local WIP.
No AGENTS.md, readme.md or test.txt was changed.

This is a source audit of rendered text, labels, placeholders, tooltips, native
login controls and exception-to-UI paths. It is not a claim that every error was
reproduced on the phone. Titles, chapter numbers, provider metadata, server error
bodies and localized iOS/network errors are dynamic, so there is no finite list
of their possible wording. The accompanying
[location inventory](app-visible-text-inventory.json) records the literal sources
and text sinks, including diagnostic-only throws; the classifications below
explain which ones actually reach UI.

## Findings and this pass's change

| App | Port-added visible text | Status |
| --- | --- | --- |
| Hitomi / Imhen | `Page N: Image could not be loaded.`, `Page N: <exception>`, thumbnail `<N> · <exception>` | Removed in build 12. The userscript renders none of these. |
| Hitomi / Imhen | Reader/Home `Loading…`; raw reader/startup/pagination exceptions; `Storage error: <exception>` | Still present; app shell additions/differences. Listed for review, not silently removed in this first fix. |
| All six Manga apps | `Opening library…`; reader image `Page N` alt text; top-level/First-chapter raw errors; catalog exception text | Still present; app additions. |
| All six Manga apps | `First chapter` | Explicitly requested app adaptation, keep. |
| Ytb | `Could not load Ytb. Reopen to retry.` | Extra app-only catch-all; only inserted when the body is otherwise empty. |
| Ytb | `Could not load Ytb data. Reopen the app to retry.` | Adapted userscript storage-error wording; userscript says KM/website data. |
| Tango | Added `Retry` link after startup failure | App-only addition. Shared userscript status renderer does not add this link for Tango. |
| Tango / Tango Login | Native login instructions, import/cleanup buttons and auth errors | Added for the explicitly requested Safari-to-app authentication handoff. |
| Xvid inside Tango | No separate rewritten viewer text layer | Packaged from shared Stream Viewer source; title/extension description renamed for the requested move. |

The Gallery per-image overlays came from the Gallery Downloader shell. The old
source even labels that shell as ported from Gallery Downloader. Sharing provider
parsing and the retry registry did **not** make that replacement shell faithful
to Gallery Reader. The removed overlay and thumbnail alt-error branches were
unnecessary for WKWebView.

This pass changes only Gallery Reader's per-image error presentation and its
build workflow. It does not change retry intervals, image fetching, favorites,
progress, history, or Gallery Downloader. Actual failed-image responses remain
failures and still use the shared userscript retry registry. There is no new
error placeholder, helper UI, fallback URL or substitute image.

## Gallery Reader: Hitomi and Imhen

Native presentation: `gallery-reader/apps/ios/web/gallery-app.js`,
`gallery.css`, `index.html`. Userscript references:
`src/routes/reader.ts`, `src/ui/gallery-row.ts`, `src/ui/paginated-grid.ts`,
`src/ui/shell.ts`, `src/ui/info-modal.ts`, `src/routes/home.ts`.

**App-only or different:**

- Removed per-image overlays and exception-bearing thumbnail alt text as above.
- `Loading…` in the initial Home footer and while opening a reader. The source
  reader has no loading label; its info modal's separate `Loading...` is shared.
- `Storage error: <exception>` from the copied shell's worker.onerror handler.
  The current `online.ts` adapter does not emit worker.onerror; this is a residual
  display path, not evidence that users presently encounter that label.
- Raw exceptions in `reader-message` on reader open/init failure and in Home
  `status` on init/pagination failure. Source reader `open()` rejects without
  creating an error panel. Source Home initialization instead has the specific
  `Could not load local reader data. Keep website data intact and reload to retry. <reason>`
  error in the grid. Those are different presentations and triggers.
- The copied shell accepts `notice` text, but the current online adapter never
  emits notices. It is an inactive channel, not a new fixed message.
- Added accessibility names `Pages`, `Reader`, and `<title> · page N` for thumbnail
  links. They are not painted helper messages, but are included in this audit.

**Matches/shared with the userscript:**

- `Search...`, `Search`, `Favs`, `~N Favorites`, `~N Results`, page numbers,
  `Show N more`, saved query text, `×`, `i`, `…`, `❤️` and `🤍`.
- Import: `Import / Merge`, `Paste gallery IDs (space, newline, comma separated)`,
  `Merge`, `Export`, `Merging...`, `Added N of M IDs`, `No IDs found`,
  `Error: <reason>`.
- Reader: `This gallery has no readable images.` This is explicitly in source.
- Row metadata failure: `Gallery <id>: <reason>` is already in the userscript;
  it is not the removed per-image error overlay.
- Info modal: `Loading...`, `Failed to load gallery info`, `Artist`, `Group`,
  `Series`, `Type`, `Characters`, `Language`, `Pages`, `Date`, `Tags`, `Close`,
  plus provider titles/tag values. `Gallery information` is the shared aria label.
- PC backup UI is imported from `src/core/pc-backup.ts`, not created by the port:
  `<app> · <provider>`, `On this phone: ...`, `Backup name (e.g. My iPhone)`,
  `Back up this phone`, `On PC: ...`, `No backup for this provider on the PC yet.`,
  `Restore from PC`, `Later`, and the note explaining replacement/independent backup.
  Success/failure notices are `Backed up to PC: ...`, `PC backup NOT completed: ...`,
  `Keep the phone’s data. Revisit home to retry.`, and `(tap to dismiss)`.
  Backup validation/server errors can form the dynamic reason. These may still
  be unwanted product text, but they are **not a userscript-to-app divergence**.

**Native errors:** `Invalid reader request` can reject the bridge; invalid
route/state/network requests are not a separate native alert. `Image request
failed (HTTP N)` from GalleryStore goes to WKURLSchemeTask's failure, causing an
image error rather than supplying that HTTP phrase to the DOM. After this fix
there is no per-image UI handler converting that event into text. Foundation and
shared provider/worker exceptions can still reach the general error sinks above.
`Invalid gallery`, `Image URL missing` and document-suspension errors are adapter
exceptions, not deliberate labels. Image-URL failures are now logged only by
loadImage, without writing their text into a slot.

## Manga Reader: Asura, Scythe, Yaksha, QiScans, Lua, EzScans

Native presentation: `manga-reader/apps/ios/Resources/Web/app.js` and `index.html`.
Reference: `src/routes/home.ts`, `src/routes/reader.ts`, `src/core/home-format.ts`,
`src/core/home-backup.ts`.

**App-only/different:**

- Bootstrap `Opening library…`.
- `Page N` image alt text. Source reader images have no alt text. This can be
  visible when an image fails; it is not an overlay, but still a port addition.
- `report(error)` paints raw errors on initial reader/init failure and failure of
  the app's First-chapter button. The source top-level `main()` does not render
  a catch-all error panel. Cover failure itself still uses the matching tooltip.
- Home catalog status uses `state.catalogError` directly. Source Home does not
  render a caught catalog exception in this status line.
- `First chapter` is app-only and was expressly requested because there is no
  address bar. `Resume <series>` is an added cover accessibility label.
- Native backup/parser/network errors have different wording from the JS
  implementation even where they reach a shared-looking status control.

**Matches/source-derived:**

- `Chapter N`/provider chapter label; `Locked`; `Unavailable chapter` aria label;
  `No chapters available`; `Failed to open series` tooltip.
- `Loading latest updates…`, `Loaded N series`, `Loaded N of M series`,
  `· loading more…`; date/countdown labels `Just now`, `Nm ago`, `Nh ago`,
  `Nd ago`, `last week`, `N weeks ago`, `0m`, `Nh Nm`.
- `Loading chapters...`, `Loading newer chapter...`, `Chapter unavailable`,
  `Failed to load chapter`, `Failed to load chapter list`, `Progress sync failed`.
  The latter also exists in the userscript for local progress-persistence failure;
  its wording alone does not imply that server tracking still exists.
- `Load`, `Save`, `Loaded`, `Saved`, `PC request failed`, and the two replace-local/
  replace-PC tooltips match `home-backup.ts`.

**Native exception families that can be displayed through those sinks:**

- `Chapter unavailable`, `Server returned HTTP N`, `Invalid server response`.
- Provider validation: invalid/incomplete catalog, series, chapter list, chapter
  images, page URL, repeated page/pagination, missing reader data. Exact literals
  and file locations are in the inventory (AsuraAPI, AngularAPI, ScytheAPI,
  LuaAPI, YakshaAPI). These are not twelve new UI controls; they are raw exception
  messages that the app's generic rendering can expose.
- Store/bridge validation: `Invalid series`, `No chapters found`,
  `Chapter list repeats a chapter`, `Invalid chapter`, `Invalid page`,
  `Invalid reading position`, `Invalid view position`, `Invalid reading checkpoint`,
  `Unknown reader request`, `Invalid reader request`.
- PC actions: `PC unavailable`, `No saved reading state on PC`, `PC request failed`,
  `Unsupported reading backup`, `Wrong provider in PC state`,
  `Invalid backup position`, `Invalid backup history`.
- Image/file-only failures such as `Image download failed`, `Invalid local host`,
  `Missing bundled reader` go through the URL-scheme failure path when serving
  an image/resource. Do not mistake every throw in the inventory for painted text.

## Ytb (km-explorer)

The builder imports the source route/UI modules. It rewrites `KM` to `Ytb` and
website-storage instructions to app instructions. Source locations and native
additions are in the inventory.

- Extra app-level fallback: `Could not load Ytb. Reopen to retry.`
- Adapted shared storage error: `Could not load Ytb data. Reopen the app to retry.`
  Source: `Could not load KM data. Keep website data intact and reload to retry.`
- Shared: `Loading…` / `Loading...`, `No favorites yet`, `No videos found`,
  `No actor videos found`, `Could not load this video’s source. Reload to retry.`,
  `No video source is available.`, `Copy`, `Copied`, `Copy failed — tap to retry`,
  `00:00.000 / 00:00.000`/formatted playback times, play/pause/mute and heart icons,
  `Favs`, numeric pages, titles, channel/actor names.
- Shared import: `Import / Merge`, `Paste IDs (space, newline, comma separated)`,
  `Merge`, `Export`, `No IDs found`, `Merging...`, `Added N of M IDs`, raw merge
  failure text. Favorite failures set a raw-error tooltip in source too.
- The same PC backup labels/notices listed for Gallery come from Ytb's shared
  source. Builder renaming also affects their app name.
- `Invalid Ytb request`, `Unsupported Ytb destination`, `Document suspended`
  are native/adapter errors, not separate labels. Shared catch sites determine
  whether they surface as a tooltip/import error, generic source error, or console
  rejection. There is no added native UIKit error alert.

## Tango and Xvid

Shared viewer UI: `stream-viewer/src/routes/*`, `src/core/start.ts`, `core/page.ts`.
Native additions: `apps/ios/web/app.ts`, `App/WebController.swift`,
`App/TangoAuth.swift`, `Login/Resources/popup.{html,js}`.

**Tango additions:**

- Startup catch appends `Retry` to the shared startup error; userscript Tango
  does not add that link.
- Login statuses: `Tango login is required.`,
  `Confirm that Tango’s Safari website data has been cleared.`,
  `Tango returned HTTP N.`, `Invalid Tango response.`,
  `Could not connect to Tango. Retrying…`.
- Native instructions: `Sign in with Google on Tango in Safari. Enable Tango
  Login and choose Import login into Tango. Close Tango tabs, then delete only
  Tango in Safari’s Website Data settings.` Buttons: `Open Tango in Safari`,
  `Safari data cleared — continue`.
- Tango Login extension: `Import login into Tango`; `Sign in on tango.me first.
  You can disable this helper after import.`; `Importing…`; `No Tango login found.
  Sign in on tango.me and allow this helper access to Tango websites.`;
  `Login saved. Close Tango tabs and remove tango.me in Safari Settings → Advanced
  → Website Data. Then open Tango and confirm cleanup. Do not use Log out.`;
  `Import failed. Check website access and try again.`
- Keychain read/save exceptions and localized errors can replace the native
  login label or go through bridge rejection. `Invalid native request` and
  `Unknown native request` are bridge validation reasons.

**Shared viewer / Xvid source, not port additions:**

- `Loading…`, `No live streams are available.`, `No uploads yet.`,
  `Loading more uploads…`, `XVideos login is required.`, `Log in`,
  `Loading more uploads… Retrying automatically.`, `Open XVideos account / login`,
  `Uploads`, `Unable to load streams.` and dynamic provider/request errors.
- `Multi: On`, `Multi: Off`, mute/play/pause/follow/block/download icons,
  `Loading highest quality…`, quality/playback errors and times. Tooltips:
  `Mute`, `Load and play neighboring videos`, `Follow or unfollow`, `Block`,
  `Download list`, `Play or pause`, `Retry playback`; `Seek video` aria label.
- Follow failure `❓`, download error `⚠️`/error tooltip, and provider `Video <id>`
  title fallback originate in the shared source.
- The Xvid extension identity/description is `Xvid` / `Stream Viewer for XVideos,
  hosted by Tango.` No separate Xvid native viewer is being shipped.

## Gallery Downloader: separate offline product, unchanged

Included because the request says all apps. This is **not** assessed as an online
Gallery Reader port. Existing background-sync WIP is untouched; a new WIP pause
sentence must not be reported as an installed build's behavior.

Its intentional offline UI includes `Download all`, `Stop`, `Resume downloads`,
`N Favorites`, `Opening saved pages…`, `N/M pages saved`, and (web-only) `Page N
is not saved. Only the first M pages are available.` It retains `Page N: Saved
image could not be decoded.`, raw page/thumbnail errors, row title/error messages,
`Storage error: ...`, and startup/open exception text. These are the origin of
the copied Gallery Reader per-image messages removed in this pass.

Native progress/error text includes `Connecting to your favorites…`,
`Opening saved favorites…`, `N favorites · M ready`,
`N favorites · loading new gallery details…`, `PC unavailable; keeping saved galleries.`,
`N galleries · M/T pages saved · <size> total`, `Saved for offline reading.`,
`Saving source thumbnails…`, `N downloads waiting for automatic retry. <reason>`,
`<kind> · gallery N/M · page/total`. Committed pause wording is `Paused. Downloads
continue when the app is active.`; unrelated local WIP changes it to `Paused.
Downloads resume in foreground or when iOS grants background time.`

Native validation messages: `The PC returned an invalid gallery manifest.`,
`The PC returned an invalid favorites catalog.`, `The PC returned HTTP N.`,
`This page isn't saved yet.`, `An image download was incomplete. It will retry
automatically.` Shared offline HTML also contains service-worker update/offline
shell notices; the native shell bypasses the service-worker branch. No changes
were made here.

## Loading fidelity: concrete remaining differences

Both native readers embed WKWebView. That does not make their JS image scheduler
or native network transport identical to Safari + the userscript.

| Behavior | Userscript | Current native port |
| --- | --- | --- |
| Gallery reader image activation | Creates every image, sets `loading='lazy'`, resolves/assigns every URL, registers shared retry | Separate 1000px IntersectionObserver window; per-slot RPC; no `loading='lazy'`; releases source outside window |
| Gallery Home previews | Creates thumbnail image elements with URLs and native lazy loading; requests gallery thumbnails for all rows | Row observer/metadata queue, 300px image window, six foreground tasks/two background tasks with a 16ms scheduler |
| Manga reader | Creates all chapter image elements with URLs and `loading='lazy'`; keeps them in DOM | 1000px observer window, at most four active image loads, removes images outside window and recreates them later |
| Manga unknown image dimensions | Source image/load/restore sequence | Native placeholder slots plus separate measurement RPC during restore |
| Native image transport | Browser requests provider URLs | Local URL-scheme handler and URLSession image delivery/cache |

Those are source-proven differences, **not measured proof of which one causes
all the perceived delay**. The app's requested disk download window does not,
by itself, require replacing userscript DOM lazy loading. The next behavior pass
should separate retaining that requested storage policy from restoring source
image creation/lazy loading. No arbitrary delay/concurrency adjustment was made
in this first text fix.

Lua's missing images are still unverified. Its Swift provider is an independent
SwiftSoup extraction of `img[src]` with URL validation; its JS provider scans the
raw HTML with its own image regex. Their implementations are not shared. A proper
next check must first inspect the phone’s last-read Lua chapter, as requested,
then compare both extractors on that **same failing chapter response**,
then distinguish missing extracted URLs from failed requests and from the native
visibility queue. This report does not claim Lua is fixed or attribute its
specific symptom to one of those paths without that evidence.

## Verification for this first fix

Both Hitomi/Imhen web bundles built. The browser fixture serves actual failed image
HTTP responses, asserts that the reader contains no image-error text/alt text,
then verifies retry recovery, search/favorites/info, current routing, Back, cold
restore and suspension. Both provider fixtures pass. Phone delivery is recorded
separately in Gallery Reader's `apps/ios/image-error-removal-verification.json`.
