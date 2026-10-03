# Manga-reader
iOS apps (Asura, Scythe, Yaksha, QiScans, Lua, EzScans) that rewrite the UI of the supported providers.

## What?
The apps change the UI of the supported providers so that it's easier to read. Features:
1. load newer chapter while reading current chapter.
2. on reload, restore to the appropriate page
3. the home page eventually loads all entries

## Why?
ios26 top and bottom bar transparency behaves well when (document) body scrolls and behaves badly when there is a virtual window controlled by the site.

## How?
We build our own structure from the provider's data. Infinite reader style on reader. full entries on home.

## setup
[notes.md](./notes.md)
