# Manga Reader apps

Seven native iPhone apps, one per site: Asura, Scythe, Yaksha, QiScans, Lua,
EzScans and Violet. UIKit and Swift 6, iOS 26, no WebKit. One Xcode target and one
codebase build all seven; the site is chosen at build time (`ReaderProvider` and
`ReaderOrigin` in Info.plist, from `providers.json` through
`scripts/build-guest.py`). Never copy app logic per site. Shared parts (live screen
stack, image pipeline, strip reader, HTTP client and cookie jar, durable files,
background downloads, libxml2 HTML, FrameMonitor, test hooks) come from NativeKit,
vendored in `Kit/`; see the [NativeKit guide](../../../../ios-tools/native/README.md).

## What the apps do

The owner's checklist, with test series and sites, is [test.txt](../../test.txt).

Home
- One card per series: the site's whole catalog, latest updates first. The phone's
  copy shows at once; the site is asked again in the background (at launch, on
  return to the app after 5 minutes, with a pull, and by iOS's background app
  refresh). Cards on screen stay where they are.
- A card has the cover, up to five newest chapters and "First chapter" (asked for
  because the app has no address bar). Chapter colours: read (purple), partly read
  (pink), unread (white), locked (amber, with a lock and the time until it unlocks,
  updated every minute).
- Tapping the cover resumes: a partly read chapter at its saved page, a finished
  one at its last page (so the next chapter follows on), a series never started at
  its first chapter. The one saved position per series always wins.
- Tapping a chapter: the saved chapter opens at its saved page, an older (read) one
  at its last page, a newer (unread) one at its top. Locked chapters do not open.
- The end of the list shows "Loaded N of M series" and, while the PC answers,
  **Load** and **Save**.

Reader
- The series as one vertical strip: the chapter opened, then each newer chapter
  appended when reading reaches the last one held (exactly once; never older
  ones). Next follows the site's list order, not chapter numbers.
- When scrolling settles, the page at the screen's centre is the series' progress;
  the exact point (that page and how far down it) goes to `positions.json`.
  Opening a chapter at a saved page puts that page's top at the top of the screen;
  reopening a series from Home at the page it was left on, or a relaunch, returns
  to the exact point.
- Saved chapters and lists open without the network. The chapter list is asked for
  once the chapter is on screen, again every 5 minutes while the newest listed
  chapter is read (a reader can stay open for days), and on return to the app. A
  failed list or newer chapter is retried after 15 s.
- "Chapter unavailable" when the site has no readable chapter (missing, locked or
  paid); the reader does not skip to a later one. Also "Failed to load chapter",
  "Failed to load chapter list", "No chapters available". Pages that fail to load
  are asked again.
- Half a screen of space above the first page and below the last. Pinch or double
  tap zooms; the back swipe is off while zoomed. The screen does not lock while
  reading.

Navigation: no bars. The left edge goes back (to the same Home, at once), the right
edge goes forward to the screen last left. The whole stack, both directions, comes
back after a relaunch.

There is no server history, tracking, provider login, search, settings or icon
artwork (iOS supplies its standard fallback icon).

## Code map

| Path | What it owns |
| --- | --- |
| `MangaReader/AppDelegate.swift` | Launch, the background app refresh task (`<bundle id>.refresh`, earliest 20 minutes after leaving), background URLSession events, the dark window. |
| `MangaReader/AppController.swift` | The app object: data folder, site HTTP client (the site's origin as Referer, cookies), provider, image pipeline (192 MB, 6 decodes), screen stack (`navigation.json`), lifecycle hooks, simulator test-hook actions, the one-time `views.json` migration. |
| `MangaReader/Providers.swift` | The seven sites: catalog pages, chapters, chapter lists, first chapter. |
| `MangaReader/Site.swift` | Every site request within the site's per-minute budget. |
| `MangaReader/Downloads.swift` | `MetadataQueue` (screen work before background work), `ChapterSource` (saved chapters and lists first, the site when needed), `ImageFiles` (the only owner of image bytes; cover rechecks). |
| `MangaReader/Library.swift` | The catalog walk, the download plan, pruning, page sizes recorded from images, positions, the hand-off to iOS's background session and background refresh. |
| `MangaReader/Store.swift` | Reading progress (`database.json`), saved chapters and lists (`chapters/`), `withNewerChapters`, the catalog as last seen. |
| `MangaReader/HomeScreen.swift` | Home: cards, chapter colours and taps, status line, Load/Save. |
| `MangaReader/ReaderScreen.swift` | The reader: opening, appending newer chapters, settling, list refreshes. |
| `MangaReader/PCSave.swift` | The PC Load/Save client. |
| `Kit/` | Vendored NativeKit. Do not edit here (see Rules). |
| `Resources/Info.plist` | The shared Info.plist; the builder sets `READER_PROVIDER`, `READER_DISPLAY_NAME` and `READER_ORIGIN` from `providers.json`. Background fetch, the refresh task ID, local network access for the PC. |
| `Resources/Native/` | Private, ignored `BackupConfig.json` and `LocalCA.cer`, bundled as `Native/`. |
| `providers.json` | The seven apps: builder argument, product name, display name, bundle ID, site key, origin. |
| `scripts/` | `build-guest.py` (builder), `build.sh`, `deploy.py`, `renewal.py`, `test.sh`. |
| `Tests/` | `MangaTests.swift` with saved site responses in `Fixtures/`; `test_signing_lock.py`. |

## Apps and identities

| Builder argument | iOS name | Site key | Installed bundle ID |
| --- | --- | --- | --- |
| asura | Asura | asurascans | com.visar.AsuraReader.paid |
| scythe | Scythe | scythescans | com.visar.ScytheReader.paid |
| yaksha | Yaksha | yakshacomics | com.visar.YakshaReader.paid |
| qiscans | QiScans | qimanga | com.visar.QiMangaReader.paid |
| lua | Lua | luacomic | com.visar.LuaReader.paid |
| ezmanga | EzScans | ezmanga | com.visar.EzMangaReader.paid |
| violet | Violet | violetscans | com.visar.VioletReader.paid |

The site key names the site in reading progress and in the PC's files. The product
name (`AsuraReader`, ...) names the data folder. Changing either orphans the
phone's data, so neither changes.

## Sites

All site requests send the site's origin as Referer and time out after 20 s without
data. Reads retry on lost connectivity and on 408, 429 and 5xx (honouring
Retry-After), backing off from 1 s to 30 s. An entry the site sent incomplete is
skipped, not the whole page (one QiScans series without a cover once stopped every
catalog walk). Asura, EzScans and QiScans give page sizes; Lua, Scythe, Yaksha and
Violet do not.

- **Asura** (JSON API, `api.asurascans.com`). URL slugs carry a rotating hex
  suffix (`-[0-9a-f]{8}`); the series identity drops it, and `routes.json` keeps
  each series' current slug for requests. Covers use the `-400.webp` variant. The
  last catalog page omits `has_more`: paging stops unless it is true. A catalog
  entry can lack `latest_chapters` (no chapters). Chapter lists are edge-cached for
  an hour, so they are asked with a unique `nocache=` query; the API answers a
  cache miss in about 0.1 s. Premium chapters are locked until
  `early_access_until`; a chapter answering `is_locked` is unavailable.
- **EzScans and QiScans** (one JSON API: `vapi.ezmanga.org`, `api.qimanga.com`).
  60 requests a minute per address, then 429 with a wait of up to a minute for
  every request, the chapter being opened included. Catalog: latest updates (50 a
  page), then the whole catalog (100 a page); `perPage=1000` answers 400. A chapter
  with a price is locked until `becameFreeAt`; a chapter answering `isFree: false`
  or `requiresPurchase: true` is unavailable. The first chapter is one request
  (`sort=asc&perPage=1`).
- **Lua** (JSON API, `api.luacomic.org`; chapters from the website's pages).
  Needs its real Referer (403 otherwise). The API answers a query it has answered
  before (for anyone) at once and others in 5 to 25 s. Catalog: the newest 100,
  then the whole catalog in one answer (offset pages repeat and skip series that
  share a sort key). Lists: for the screen, the page of 1000 races the website's
  own pages of 30 (nearly always warm); the background asks only the page of 1000.
  Chapter pages put some images in `data-src` instead of `src`; both are read.
- **Scythe** (WordPress, MangaReader theme, parsed with libxml2). Never
  cache-bust: the origin renders an uncached page in 6 to 85 s (its feed and REST
  API took over 40 s), so only Cloudflare-cached pages are read. The cached series
  page can lag; the first Latest Update page is purged on publish, so its newer
  chapters go in front, joined through each chapter page's `prevUrl` when the gap
  is larger (at most 10 steps or 10 s). A list with a hole is never returned; the
  cached list is, and the next refresh retries. Later home pages' edge copies can
  be weeks old.
  Chapter IDs are `<series>-chapter-<n>[.m][-k]` (`-chapter-194-2` is 194).
  Coin-locked chapters carry `center-lock`. Pages come from the base64
  `ts_reader.run` data's default source.
- **Yaksha** (WordPress, Madara theme). A missing chapter answers 200 with the
  series page: it counts as unavailable. The list is each chapter row's own link
  (reading the number after "Chapter" lost titled chapters such as "Chapter 3 -
  Ashen City" and decimal ones such as `chapter-1-1` in 18 of 62 series).
- **Violet** (WordPress, MangaReader theme; `violetmanga.com`, formerly
  `violetscans.org`, whose site key the app keeps). Every page is sent
  `Cache-Control: no-store`, which is why the Safari version could not keep it; the
  app reads pages itself, so it does not matter. Catalog: the home page's Latest
  Comics (pinned series, then the 25 newest), then the same list's "load more"
  (`POST /wp-admin/admin-ajax.php`, `action=load_more_manga_posts&page=N`, 12 comics
  a page from page 2; page 1 repeats page 2; novels load through another action).
  Past the last page the site answers `{"success":false,"data":"No more posts"}`;
  that or a short page ends the catalog, and a failed request throws (ending the
  walk on one would drop every series not yet read). A chapter is its address's own
  path part (`<series>-chapter-<n>`). Pages come from the inline `ts_reader.run`
  data's default source; the title from `HISTORY.push`. A coin-locked chapter's
  page shows `lock-status` (unavailable); in the series list it has no link (a
  purchase dialog) and is left out; on Home its row carries `fa-coins`.

### Request budget and queue

`SiteClient` (Site.swift) keeps each site within a per-minute budget: QiScans and
EzScans 50 a minute, of which background work may use 30; the others 120, of which
60. Work for the screen has the rest. A 429 holds that host's requests until its
wait is over. Every request to a site's pages or API goes through it.

`MetadataQueue` runs up to six pieces of work for the screen at once. Background
work (catalog pages, the plan's chapters and lists) runs two at a time and waits
while any screen work runs, so a chapter being opened never shares the site with
it. Background work the screen then asks for becomes urgent. List pages are asked
four at a time for the screen, one at a time in the background.

Opening a series never started asks only for its first chapter (from a kept list,
else the site's first chapter where the site can say); the list follows once the
chapter is on screen.

## Data on the phone

Everything is in `Library/Application Support/<product name>/shared/`, the folder
the earlier web version used, so its data carried over. Every change is written
atomically when it happens.

- `database.json`: reading progress, one position per series (`provider` +
  `"\0"` + series identity), the page index and page count. Version 1, schema 3
  (`progress-schema-version`), with the v1-to-v3 migrations; the PC keeps the same
  shape. Its `tokens` rows are legacy and kept untouched. A file that cannot be read
  is set aside as `database.unreadable-<time>.json`, never overwritten.
- `positions.json`: the exact point per series (chapter, page, fraction).
- `navigation.json`: the screen stack. `views.json`, the web version's, is read
  once when `navigation.json` does not exist yet.
- `catalog.json` (the catalog as last seen), `routes.json` (current slugs),
  `cookies.json`.
- `chapters/<sha256(key)>.json`: a chapter's pages (with sizes once known) or a
  series' list, under the web version's keys (`["<series>","<chapter>"]`,
  `["chapters","<series>"]`). A list file's date is when the site last gave it, so a
  relaunch does not ask for every list again.
- `images/` and `covers/`: `<sha256(url)>`, complete only once its `.mime` marker
  exists; a cover's validators are in `<file>.check`.
- `debug-state.json`: written whenever the app leaves the screen (see Inspect).

## Catalog, downloads, covers and pruning

- The catalog walk: a full walk (up to three pages in flight; at its end, series
  the site no longer lists go) when the phone's catalog is empty, incomplete or a
  day old; otherwise pages from the newest until one changes nothing. A series seen
  twice in one walk (latest updates, then the catalog) merges its new chapters into
  the first row, up to five.
- Every started series keeps its current and next chapter on the phone (not the
  previous one); once the current one is finished, the next comes first.
- Order: pages on screen first (shared per image, dropped when nobody waits); then
  the plan: the chapter being read from the page on screen, then its next; then
  every started series, the most recently read first; then every catalog cover.
  Planned files download three at a time, one while pages on screen load; a failed
  one waits 15 s, doubling up to 10 minutes.
- A new chapter is noticed as soon as Home's catalog or a chapter list shows it.
  A Home row extends a kept list when it continues that list exactly for at least
  two chapters, so a new chapter is known before its list request returns. Started
  series' lists are asked again when older than 15 minutes.
- Leaving the screen hands up to 400 unfinished planned files to iOS's background
  session (`<bundle id>.images`), which carries on while the phone is locked or
  the app is away; they are taken back on return. iOS's background app refresh
  reads the newest catalog pages and hands off the chapters they reveal.
- Pruning: page images outside the plan are deleted once no reader holds them
  (readers kept for going forward hold their chapters). Reading progress, saved
  chapter files and lists stay. Covers are never deleted.
- Covers: a cover on screen not asked about for six hours is asked again, lazily,
  one at a time, behind everything else, with a conditional request (ETag,
  Last-Modified; a cover from before validators were kept uses its file's date).
  All seven sites answer 304 with no bytes when it did not change. Only new bytes
  replace the file, and the card shows them in place.

## Restore and the main thread

These are the owner's requirements; NativeKit's guide has the shared mechanics and
how to measure them.

- The first frame after a relaunch is the screen as it was left. Covers and pages
  on the phone decode before it (NativeKit's restore mode,
  `ImagePipeline.beginRestore`), Home goes straight to its anchor, the reader lays
  out its saved chapter at once, and the screens below are built while the top one
  shows, so going back finds them complete.
- Nothing moves while images load: page sizes are known before a chapter is laid
  out, from the site or recorded from the images on the phone into the chapter
  file. A page of unknown size waits at 1000 points until its image says.
- The main thread only shows. Catalog pages are merged, compared and turned into
  chapter rows off it (`Library.step`); the download plan is worked out off it from
  a snapshot (`Library.plan`); file names (SHA-256 of URLs) and site dates are
  computed once each; Home under a reader does not redraw its cards; a newer catalog
  waits while Home's cards move (setting the offset would stop a fling).
- Images decode off the main thread: those on screen first at high priority, those
  ahead at low priority two at a time (a 57 MB page decoding ahead must not take
  the cores the screen needs). Tall pages are drawn in slices made display-ready off
  the main thread.
- FrameMonitor counts frames over 25 ms while scrolling, with the spans of app code
  in them (`home.cell`, `reader.settle`, ...). The goal is none. On 2026-10-13
  Asura, EzScans, QiScans and Scythe had none on Home and in the reader; Lua's one
  and Yaksha's three were 17000-pixel pages appearing, since drawn in slices
  prepared off the main thread.

## PC Load and Save

Save replaces the PC's copy of this site's reading state with the phone's; Load
replaces the phone's positions for this site with the PC's, even if older. Other
sites' positions and the `tokens` rows stay. Load rejects a save holding another
site's positions or a repeated series; an empty save is a valid Load. Nothing is
automatic: no merging, polling or background backup. The controls show only while
the PC answers; requests give up after 5 s. The server is in
[server/README.md](../../server/README.md).

The app reads the PC's address and key from the ignored
`Resources/Native/BackupConfig.json` (`url`, `key`) and trusts the PC's mkcert CA
from `Resources/Native/LocalCA.cer`; without them there are no PC controls. Built
apps contain the key: never publish or share them.

## Build, test, deploy

Mac and phone access: [mac-access.md](../../../../../environment/mac-access.md)
(`ssh mac`). If Ethernet `192.168.1.198` does not answer, ssh and `deploy.py` reach
the Mac through its Wi-Fi automatically;
`/home/visar/Documents/environment/mac-access/mac-connect --check` shows why. The
Mac mirror is `/Users/visar/Developer/manga-reader/apps/ios` for all seven apps.

Deploy from the manga-reader root on this PC, one app at a time:

```sh
python3 apps/ios/scripts/deploy.py sync asura     # rsync apps/ios to the Mac mirror (--delete)
python3 apps/ios/scripts/deploy.py build asura    # signed build on the Mac, attached; records its inputs
python3 apps/ios/scripts/deploy.py install asura  # checks, installs over the app, approves it for renewal
python3 apps/ios/scripts/deploy.py launch asura
```

`status` shows the build log's tail; `check` runs the install checks without
installing. The ignored `deploy.local.json` holds `host`, `knownHosts`, `guiUid`
(501), `signingTeam` (paid team `65U58U86DD`), `device` (the phone,
`00008101-000639912881401E`) and `bundleSuffix` (`.paid`). Output example:
`build/asura.paid/Release-iphoneos/AsuraReader.app`.

The build enters GUI UID 501 with `sudo launchctl asuser`, drops back to that user,
and supplies signing team, bundle suffix and device. It creates no LaunchAgent; keep
SSH attached until it reports BUILD SUCCEEDED. The builder checks the display name,
provider, bundle identity, absence of icon declarations, complete signature,
profile team and that the phone is in the profile. Install also checks every
bundled `Native` file's hash (the PC's address, key and CA) and the bundle ID. A
signing lock (`~/Library/Caches/ios-app-refresh/signing.lock`, shared with renewal)
refuses overlapping builds.

Tests:

```sh
ssh mac 'cd ~/Developer/manga-reader/apps/ios && bash scripts/test.sh'  # after deploy.py sync <any app>
npm run test:ios:signing   # the builder's signing lock (this PC)
npm run test:server        # the PC server (this PC)
```

`scripts/test.sh` checks all seven providers against saved responses
(`Tests/Fixtures`, fetched through URLSession on the Mac), the reading state's
format, migrations and rules, and the request budget. NativeKit's own tests run
from ios-tools (`native/scripts/kit-test.sh`).

Simulator, on the Mac mirror:

```sh
SIMULATOR=1 /usr/bin/python3 scripts/build-guest.py asura  # build/asura/Release-iphonesimulator, bundle ID without .paid
```

Simulator builds include NativeKit's test hooks on `127.0.0.1:8765` (see the
NativeKit guide), driven from this PC with ios-tools' `native/scripts/sim`. This
app adds two actions: `/action?name=open&series=…[&chapter=…][&image=…]` and
`/action?name=refresh[&full=1]`. NativeKit's `restore-check` (fast, coded) and
`restore-video.sh` (slow, visual) check the relaunch. Gestures, feel, frame times,
background downloads and background refresh are checked on the phone.

## Inspect on the phone

The app writes `debug-state.json` (screen stack, Home anchor, reader state,
library and pipeline counts, and FrameMonitor's "frames") whenever it leaves the
screen. Use the app, leave it, then from this PC:

```sh
../../ios-tools/native/scripts/frames com.visar.AsuraReader.paid 'Library/Application Support/AsuraReader/shared'
```

(run from the manga-reader root; `--json` for the whole report). It copies the file
with `xcrun devicectl device copy from --device <phone> --domain-type
appDataContainer --domain-identifier <bundle id> --source '<folder>/debug-state.json'`
on the Mac.

## Renewal

The seven apps renew monthly through this repository's Mac scheduler,
`com.visar.renewal.manga-reader`; see the
[renewal guide](../../../../ios-tools/renewal/README.md) and its paid-signing
lessons. `scripts/renewal.py` lists the apps and fingerprints their inputs:
`MangaReader`, the Xcode project, `Kit`, `Resources/Info.plist`,
`Resources/Native`, `providers.json` and `scripts/build-guest.py`. A changed input
(code, a re-vendored Kit, even a comment) blocks unattended renewal of every app
that uses it until that app is deployed again with `deploy.py build` and `install`,
which approve the new baseline. Approval is skipped when the inputs changed between
build and install (another sync) or when the build was unsuffixed. The seven apps
share their inputs, so a change means deploying all seven: the app the change is
about first (the owner tests each app as it appears on the phone).

## Rules

- Never uninstall an app to update it: that deletes its reading progress and
  downloads. `deploy.py install` installs over it and keeps its data.
- Keep `bundleSuffix: .paid`. Without it the builder makes the registry's
  unsuffixed identities: a second app, not an update, and no renewal approval.
- Never commit `deploy.local.json`, `Resources/Native/BackupConfig.json` or
  `LocalCA.cer`, and never publish built apps (they contain the PC's key).
- Never press Save from a simulator build: it replaces the PC's copy.
- Do not edit `Kit/` here: change ios-tools' `native/Kit` and re-vendor with
  `native/scripts/vendor-kit.py` (`--check` shows a differing copy).
- Every site request goes through `SiteClient`; never bypass the budget.
- Never cache-bust Scythe; keep Asura's list bypass.
- Never change a site key or product name in `providers.json` (see Apps and
  identities).
- When copying files into an app's container with `devicectl device copy to`,
  never pass `--remove-existing-content`.
