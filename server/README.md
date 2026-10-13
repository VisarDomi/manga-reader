# PC Load/Save

The manga apps show **Load** and **Save** under Home's loaded count when this
server answers (`backups.mjs`, HTTPS on port 7711). The app side is described in
[apps/ios/README.md](../apps/ios/README.md#pc-load-and-save).

- `GET /api/reader-backups/manual/manga-reader/<provider>/status` only reports
  availability; it never reads or transfers reading state.
- `GET …/<provider>` loads the saved state (404 until the first Save).
- `PUT …/<provider>` replaces it explicitly, including older, backward or empty
  progress. Malformed state (or a body over 5 MB) is rejected and leaves the file
  unchanged.

`<provider>` is the site key: `asurascans`, `scythescans`, `yakshacomics`,
`qimanga`, `luacomic`, `ezmanga`. There is no automatic publishing, merging or
polling. Each provider's `manual-manga-<provider>.json` holds the current and the
previous complete snapshot. Load replaces only that provider's progress on the
phone; the legacy `tokens` rows stay local.

The service is the systemd user unit `manga-reader-backups.service` (a copy is in
this folder; chezmoi restores the installed one on a new PC). It runs
`server/backups.mjs` with the PC's mkcert certificate (`~/.local/share/mkcert/pwa`).
Data and the access key (`access-key`) live in `~/.local/share/manga-reader/backups/`
(mode 0700/0600, never in Git). The server creates the key on first start. The apps
get the PC's address and that key from the ignored
`apps/ios/Resources/Native/BackupConfig.json`, and trust the PC's mkcert CA from
`apps/ios/Resources/Native/LocalCA.cer`. Built app bundles contain the key: never
publish them. Keep that folder, key included, when moving the service to another PC;
a new key or address means updating `BackupConfig.json` and redeploying all six
apps.

```sh
systemctl --user status manga-reader-backups.service --no-pager
npm run backups:status   # what each phone saved (dates and counts only)
npm run test:server
```

Every response is `no-store`, and requests without the key get 401. Files are
written durably: temporary file, fsync, rename, directory fsync. This is a local-PC
backup, not protection against losing the PC.
