# Manga-reader
Native iPhone apps (Asura, Scythe, Yaksha, QiScans, Lua, EzScans) that rework the supported providers into a fast reader.

## What?
The apps change the UI of the supported providers so that it's easier to read. Features:
1. load newer chapter while reading current chapter.
2. on relaunch (or after a kill), return to the exact point, with nothing jumping while pages load
3. the home page shows every entry, at once from the phone's copy, refreshed in the background
4. every started manga keeps its current and next chapter on the phone; a new chapter downloads as soon as it appears, also while the phone is locked or the app is away

## Why?
Reading should be instant and offline where possible. The sites' own pages are slow and lose your place.

## How?
We build our own structure from the provider's data. Infinite reader style on reader. full entries on home.

## Docs
- [AGENTS.md](AGENTS.md): who owns the repository and where to start.
- [apps/ios/README.md](apps/ios/README.md): the six apps: behaviour, code map, sites and their quirks, downloads, restore and performance rules, build, test, deploy, inspect, renewal.
- [server/README.md](server/README.md): the PC Load/Save server.
- [test.txt](test.txt): the owner's checklist of behaviour, with test series and sites.
- [apps/ios/providers.json](apps/ios/providers.json): the supported sites.
- The docs and investigations from before the native apps are in Git history, last at `ab11b36`; the web version's code at `74c6e21^`.
