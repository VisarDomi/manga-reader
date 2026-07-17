# Manga-reader
A userscript used for tampermonkey on pc and userscript on ios.

## What?
This script changes the UI of the providers supported by this script so that's it easies to navigate the site. 1 main features are: reader. The script tries to be as minimal as possible in features and codelength.

## Why?
ios26 and ios27 top and bottom bar transparency behaves on if body scrolls or if there is a virtual window controlled by the site.

## How?
We nuke the site and build our own structure. Infinite reader style.

## Sites supported
```
match: ["https://ezmanga.org/*", "https://qimanga.com/*", "https://yakshacomics.com/*"]
```