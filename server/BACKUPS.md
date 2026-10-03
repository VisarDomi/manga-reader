# PC Load/Save

The manga apps show **Load** and **Save** under Home's loaded
count when this repository's PC server answers. It listens on HTTPS port 7711.

- `GET /api/reader-backups/manual/manga-reader/<provider>/status` only reports
  availability; it never reads or transfers reading state.
- `GET …/<provider>` loads the saved state (404 until the first Save).
- `PUT …/<provider>` replaces it explicitly, including older, backward or empty
  progress. Malformed state is rejected and leaves the file unchanged.

There is no automatic publishing, merging or polling. Each provider's
`manual-manga-<provider>.json` holds the current and the previous complete
snapshot. Load replaces only that provider's progress on the phone; sessions stay
local.

The service is the systemd user unit `manga-reader-backups.service` (a copy is in this folder); it runs
`server/backups.mjs` with the PC's mkcert certificate
(`~/.local/share/mkcert/pwa`). Data and the access key live in
`~/.local/share/manga-reader/backups/` (mode 0700/0600, never in Git). The server
creates the key on first start; builds read it from there unless
`VITE_READER_BACKUP_KEY` is set (see `.env.example`). Built app bundles contain
the key: never publish them. Keep that folder, key included, when moving the service
to another PC; a new key means rebuilding the apps.

```sh
systemctl --user status manga-reader-backups.service --no-pager
npm run backups:status   # what each phone saved (counts, labels and dates only)
npm run test:server
```

Every response is `no-store`, and requests without the key get 401. Files are
written durably: temporary file, fsync, rename, directory fsync. This is a local-PC
backup, not protection against losing the PC.
