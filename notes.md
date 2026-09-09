## more notes

An iOS Safari extension inside **Reader Extensions**, also buildable as a
userscript. See [extension setup and validation](extension/README.md).

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
Do not publish built userscripts or extension bundles containing that key. No
backup work starts before route matching and document takeover; IndexedDB stays
inside the compute worker.

## [Testing](test.md)
For the installed extension, use native Safari inspection and normal taps/swipe
Back. The optional userscript harness (`npm run tests`) injects a build; disable
the extension before using that harness so two versions cannot compete.

