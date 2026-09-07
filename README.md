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

## PC backup and restore

Initial Backup/Restore shows a success confirmation. Later automatic home backups
are silent, even when data changes. An unreachable PC, connection timeout, or
unavailable service is also silent: no setup prompt and no notification. The next
home visit retries normally. Online access/validation/storage errors remain
visible until dismissed or a successful retry. Check PC backup status before formatting—routine saves no
longer display a success toast.

Each provider home offers **Back up this phone** or **Restore from PC** on first use,
comparing local and PC counts. Thereafter home visits back up automatically. All
three script-owned IndexedDB stores are included: progress, tokens and metadata.
Restore is one atomic transaction. Different installations have independent IDs;
restoring creates a new ID and leaves the selected original backup intact.

Before formatting, install the new build and visit every provider home you use.
Initial setup shows a confirmation; verify later silent saves and received counts with
`npm run backups:status` in gallery-downloader. It keeps current plus one previous
snapshot per ID. See [the complete guide](../gallery-downloader/READER-BACKUPS.md).
Builds read the sibling server's private key automatically; see [.env.example](.env.example).
Do not publish built userscripts containing that key. No backup work starts before
route matching and stop/open/close; IndexedDB stays inside the compute worker.

## [Testing](test.md)
Install debug.user.js and change iphone display auto-lock to never (remember to change it back) then run npm run tests
