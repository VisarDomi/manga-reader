# Manga Reader provider apps

Native UIKit and Swift 6 (iOS 26), no WebKit. One target builds each of the six
apps; the provider is chosen at build time (`ReaderProvider` and `ReaderOrigin` in
Info.plist, from `providers.json` through `scripts/build-guest.py`). Shared parts
(live screen stack, image pipeline, strip reader, HTTP client and cookie jar,
durable files, background downloads, libxml2 HTML) come from ios-tools' NativeKit,
vendored in `Kit/`.

## The app (`MangaReader/`)

- `Providers.swift`: the six sites. Asura, EzScans/QiScans and Lua are JSON APIs
  (Lua's chapters are read from its pages); Scythe and Yaksha are WordPress pages
  parsed with libxml2 and the web version's patterns. Lua needs its real Referer.
  Scythe's uncached pages take up to 85 s, so its lists read only cached pages
  (`investigation/2026-10-06-scythe-next-chapter.md`). A missing Yaksha chapter
  answers with the series page; it counts as unavailable. Yaksha's list is each chapter
  row's own link (the web version's pattern lost titled chapters such as "Chapter 3 - Ashen
  City" and decimal ones such as `chapter-1-1` in 18 of its 62 series). Opening a series never
  started asks only for its first chapter where the site can say (EzScans/QiScans
  sort by number: one request); lists come after the chapter is on screen. Lua
  answers queries it has answered before at once and others in 5 to 25 s, so for the
  screen its page of 1000 and its pages of 30 race (October 11, 2026: a 237-chapter
  series took 81 s to open, now 1 to 4 s for most). An entry the site sent incomplete
  is skipped, not the whole page (a QiScans series without a cover had stopped every
  catalog walk).
- `Store.swift`: reading progress in `database.json`, the web version's format,
  validation and v1→v3 migrations (the PC keeps the same shape); saved chapters and
  chapter lists in `chapters/<sha256(JSON key)>.json` under the web's keys; the
  catalog as last seen (`catalog.json`).
- `Site.swift`: every site request within the site's budget. QiScans and EzScans
  allow 60 requests a minute, then answer 429 with a wait of up to a minute for every
  request, the chapter being opened included; the launch's catalog walk and list
  refreshes went past that. Background work spends at most 30 of 50 a minute there
  (60 of 120 elsewhere); work for the screen has the rest, and a 429 holds the site's
  requests until its wait is over.
- `Downloads.swift`: site work for the screen first (up to 6 at once; background work,
  2 at a time, waits while any runs, so a chapter being opened never shares the site
  with the plan's lists or the catalog);
  chapters and lists (the phone's copy first; a list is extended by Home's rows
  when they continue it exactly, so a new chapter is known before its list request
  returns); image files (`images/` and `covers/`, `<sha256(url)>` plus a `.mime`
  completion marker): pages on screen first, shared per image and dropped when
  nobody waits; then the planned work in order.
- `Library.swift`: the catalog walk (the phone's copy at once; a full walk when it
  is incomplete or a day old, otherwise pages until one changes nothing), the
  download plan (see `notes.md`), pruning, page sizes recorded from images,
  the hand-off to iOS's background session and background app refresh.
- `HomeScreen.swift`, `ReaderScreen.swift`, `PCSave.swift`, `AppController.swift`.
  A series reopened at the page it was left on returns to the exact point
  (`positions.json`, the page and how far down it; the reading state keeps only the
  page), as going forward to a reader does.

## The main thread only shows

Scrolling must never wait for the app's own work, so the main thread only takes results:
catalog pages are merged, compared and turned into chapter rows off it (`Library.step`), the
download plan is worked out off it from a snapshot (`Library.plan`), file names (SHA-256 of
URLs) and site dates are computed once each, Home under a reader does not redraw its cards, and
a newer catalog waits while Home's cards move (setting the offset would stop a fling). Images
decode off the main thread, those on screen first and at high priority, those ahead at low
priority two at a time (a 57 MB page decoding ahead must not take the cores the screen needs);
tall pages are drawn in slices made display-ready off the main thread (NativeKit's reader). NativeKit's
FrameMonitor measures it on the phone: the app writes `debug-state.json` ("frames": dropped
frames with what ran in them) when it leaves the screen; copy it with `devicectl device copy
from`. October 13, 2026 (all six apps, Home right after launch and the reader): Asura 1263
scrolling frames, EzScans 483, QiScans 319, Scythe 901 with none over 25 ms; Lua one and Yaksha
three (the first appearance of 17000-pixel pages, since fixed by preparing slices off the main
thread).

All data stays in the web version's folder, `Application Support/<product>/shared`:
progress, routes (Asura's rotating slugs), saved chapters and the image caches
carry over. A chapter list's file date is when the site last gave it, so a relaunch
does not ask for every started series' list again. The first launch rebuilds the screen stack from `views.json`.

## Build and check

On the Mac mirror (`~/Developer/manga-reader/apps/ios`, synced by
`deploy.py sync <provider>`):

```sh
bash scripts/test.sh                                       # providers and store
SIMULATOR=1 /usr/bin/python3 scripts/build-guest.py asura  # build/asura/Release-iphonesimulator
```

`scripts/test.sh` checks all six providers against saved responses
(`Tests/Fixtures`, fetched through URLSession on the Mac) and the reading state's
format, migrations and rules. Simulator builds include NativeKit's test hooks on
`127.0.0.1:8765` (`/state`, `/tap`, `/scroll`, `/back`, `/forward`,
`/action?name=open&series=…[&chapter=…][&image=…]`, `/action?name=refresh`),
driven from Linux with ios-tools' `native/scripts/sim`. Never press Save from a
simulator: it replaces the PC's copy. Gestures, feel, background downloads and
background refresh are checked on the phone.

Deployment, signing and renewal: [PAID-NATIVE.md](PAID-NATIVE.md). Renewal
fingerprints `MangaReader`, the project, `Kit`, Info.plist, `Resources/Native`,
`providers.json` and the builder.
