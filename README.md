# Manga-reader
A Safari extension and Safari userscript that rewrites the UI of the supported providers.

## What?
This script changes the UI of the providers supported by this script so that's it easier to read. Features:
1. load newer chapter while reading current chapter.
2. on reload, restore to the appropriate page
3. the home page eventually loads all entries

## Why?
ios26 top and bottom bar transparency behaves well when (document) body scrolls and behaves badly when there is a virtual window controlled by the site.

## How?
We nuke the site and build our own structure. Infinite reader style on reader. full entries on home.

## setup
[notes.md](./notes.md)
