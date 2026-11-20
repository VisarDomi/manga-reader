# PC Load/Save and Home search

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
`qimanga`, `luacomic`, `ezmanga`, `violetscans`. There is no automatic publishing, merging or
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
a new key or address means updating `BackupConfig.json` and redeploying all seven
apps.

```sh
systemctl --user status manga-reader-backups.service --no-pager
npm run backups:status   # what each phone saved (dates and counts only)
npm run test:server
```

Every response is `no-store`, and requests without the key get 401. Files are
written durably: temporary file, fsync, rename, directory fsync. This is a local-PC
backup, not protection against losing the PC.

# Home search

The manga apps' Home has a search box (apps/ios/README.md, "Home"). Pressing Enter sends what
was typed and the catalog's titles here; a language model answers the titles it thinks were
meant, each with a confidence, and the phone moves those to the top. `search.mjs`, served by the
same process and key as Load/Save:

- `GET /api/manga-reader/search/<provider>/status` → `{"ready": true|false}`: whether the phone
  shows the box. Ready while the main model or the fallback answers "say hi and only hi" with
  "hi". A pass counts for five minutes, a failure for one, or until the reset time the provider
  names; a model known to be down is skipped meanwhile.
- `POST /api/manga-reader/search/<provider>` with `{"query", "titles": [{"id", "title"}]}` →
  `{"matches": [{"id", "confidence"}]}`, best first, at most 20, only ids that were sent. 400 for
  a malformed request, 503 when neither model answers usefully. A reply that is not the asked-for
  JSON fails that search but does not take the model offline.
- The same query (trimmed, lower case) on the same set of titles is answered from
  `~/.local/share/manga-reader/search/cache.json` (500 entries, written durably) without asking a
  model. Titles are sorted before the prompt, so catalog order does not matter.

Models (`SEARCH_MODELS` in `search.mjs`), on the owner's OpenCode Go plan: **Claude Haiku 5.5 at
xhigh reasoning**, then **GLM-5.3-Flash at high** while Haiku is unavailable. Changing them is that
one constant and `systemctl --user restart manga-reader-backups.service`. A QiScans search
(1,040 titles, about 12,000 tokens) took 4.9 s on Haiku xhigh and costs about $0.002; Scythe's
71 titles cost a tenth of that. On November 20 GLM-5.3-Flash (default effort) answered in 3.6 s
median, DeepSeek V4.1 Flash 8.9 s and GLM-5.3 18 s, all with the right title first in 8 of 8 test
searches. OpenCode's free DeepSeek was dropped: its allowance is small, undocumented and shared by
everything on the PC (testing used up a day's allowance), and it refused calls that did not come
from OpenCode's own command line.

The models are reached through a stripped OpenCode server, `manga-search-opencode.service`
(a copy is in this folder; chezmoi restores the installed one), on `127.0.0.1:7712` only:

- `search/opencode-serve.sh` creates `~/.local/share/manga-reader/search/{workspace,opencode/*}`
  and the server password (`opencode.env`, mode 600) on its first start, then runs
  `opencode serve` with `search/opencode.json`: one agent (`answer`) with no tools and every
  permission denied, no plugins, MCP servers, LSP, formatters, snapshots, sharing, project config,
  Claude Code files or instructions, and only the `opencode-go` provider. Its configuration, state
  and cache folders are its own.
- Its data folder is the owner's `~/.local/share/opencode`, so it signs in with the existing
  OpenCode Go login (the one T3 Code and the owner's OpenCode use); no key is copied. Each question
  is a short session there (`manga search`), deleted as soon as it is answered.
- `backups.mjs` reads the password from `opencode.env` at each request, so either service can
  start first or be restarted alone.
- Away from home the two calls pass the public route with 90 s and 120 s limits
  (environment `services/hetzner-pc/pc_apps.py`).

```sh
systemctl --user status manga-search-opencode.service --no-pager
journalctl --user -u manga-search-opencode.service -n 50 --no-pager
npm run test:server        # Load/Save and search, with stand-in models and a stand-in OpenCode
```
