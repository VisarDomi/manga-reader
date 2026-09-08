# Manga Reader — Safari extension

The fourth independent iOS Safari extension inside **Reader Extensions**, whose
Apple project lives in `../gallery-reader/extension/apple/`. The host carries no
reader data. Its existing bundle ID remains `com.visar.galleryreader.extensiontest`;
this extension uses `.MangaReader`.

`npm run build:extension` produces private `dist/extension/{content.js,manifest.json}`.
Do not publish these files: they contain the PC backup access key. Six exact HTTPS
host matches come from `src/core/sites.json`. Build the whole containing app from
Gallery Reader with `npm run build:extensions`, or stage only this bundle while
preserving the other three existing bundles.

## Runtime contract

- Top-frame `document_start`, MAIN world. Provider/route ownership is checked
  before takeover, worker creation, storage or backup. Unowned pages stay native.
- A window-lifetime guard prevents duplicate startup. The Safari build stops
  loading and replaces the document's children instead of calling `document.close`,
  which caused reinjection in earlier Safari experiments. It creates its own head,
  body and mobile viewport; it does not depend on site metadata arriving first.
- Home, reader, provider behavior, progress, session cookies and PC backup use the
  same source as the userscript. IndexedDB remains page-origin, worker-owned. No
  migration to extension storage, background page, content proxy or extra cache.
- No artificial 100ms scroll delay. Reader URL/progress selection happens on
  `scrollend`; persistence is asynchronous. Normal chapter append keeps duplicate
  and unavailable-chapter guards. Home applies completed worker history results
  with generation/visibility checks; catalog pages are sequentially fetched and
  appended. Provider pacing, image retries and backup timeouts remain intentional.
- Native links and bfcache remain in charge of Back. No custom navigation UI.

This is an early document takeover, not a guarantee of zero original network
bytes or a security boundary. There are no new declarative blocking rules here.
Keep the matching userscripts disabled. AdGuard is currently off during native
testing following the separate Gallery Reader image-URL slowdown investigation.

## Validation

Version 282: TypeScript, 37 unit tests, userscript and extension builds pass.
The real IndexedDB fixture passes full-store restore, rollback after a failed
transaction, token/metadata preservation and reload persistence. Unit tests now
check reader URL updates without advancing a timer and home history without a
quiet period. The existing iOS save assertion was updated to observe the actual
scrollend result, not require the retired delay.

`npm run test:extension` passes all six provider fixtures with the real extension
installed in disposable Chromium: catalog completion without duplicates, worker
startup, native chapter links, viewport/standards mode, silent unavailable backup
and untouched unsupported routes. All network hosts map to a local TLS server;
no real account or backup is used. Timer-based observation avoids Chromium's
stalled rAF polling after parser-stop takeover. This is packaging/behavior coverage,
not a claim about live providers or iPhone scrolling.

The four-extension app builds/signs and is installed. Native iPhone Safari on
Asura reported one startup, 2ms shell setup and reader setup complete at 94ms
after navigation (one warm sample, not a benchmark), decoded images, CSS1Compat,
428px body/viewport, scale 1 and no reader errors. The user confirmed Asura looks
good and chose to perform the remaining provider/resume/swipe checks personally.
Do not describe all six live providers or their bfcache behavior as verified yet.
The native inspector is `../gallery-reader/tests/ios/native-inspector.py` on the
trusted Mac USB connection; `--site manga` selects these six hosts. Never clear
website data to test a port. Phone screenshots/traces may be private; keep local.
