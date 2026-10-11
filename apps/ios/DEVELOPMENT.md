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
  answers with the series page; it counts as unavailable.
- `Store.swift`: reading progress in `database.json`, the web version's format,
  validation and v1→v3 migrations (the PC keeps the same shape); saved chapters and
  chapter lists in `chapters/<sha256(JSON key)>.json` under the web's keys; the
  catalog as last seen (`catalog.json`).
- `Downloads.swift`: site requests (2 at a time in the background, 6 when urgent);
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

All data stays in the web version's folder, `Application Support/<product>/shared`:
progress, routes (Asura's rotating slugs), saved chapters and the image caches
carry over. The first launch rebuilds the screen stack from `views.json`.

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
