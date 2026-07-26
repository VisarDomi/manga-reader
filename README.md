# Manga-reader
A userscript used for tampermonkey on pc and userscript on ios.

## What?
This script changes the UI of the providers supported by this script so that's it easier to read. Features:
1. load newer chapter while reading current chapter.
2. on reload, restore to the appropriate page

## Why?
ios26 and ios27 top and bottom bar transparency behaves well when (document) body scrolls and behaves badly when there is a virtual window controlled by the site.

## How?
We nuke the site and build our own structure. Infinite reader style.

## Sites supported
[sites.ts](src/core/sites.ts)

## [Testing](test.md)
Install debug.user.js and change iphone display auto-lock to never (remember to change it back) then run npm run tests
