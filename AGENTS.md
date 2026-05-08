# Manga Reader

Monorepo (npm workspaces). Packages: `provider-types`, `extensions`, `server`, `app` (SvelteKit PWA, Svelte 5).

## Read on demand

- Frontend app:
  `~/Documents/work/manga/manga-reader/packages/app/AGENTS.md`

## Server management

- Main service port: `11555`
- The server runs as the systemd user service `manga-reader.service`, wrapped in `xvfb-run`.
- Do not kill or start the real service manually with `nohup`, `node`, or `tsx`.
- Use `npm run restart`, `npm run stop`, `npm run start`, `npm run status`, or `npm run logs`.

## Logs

- Start debugging by checking the managed service logs.
- Use direct `journalctl` for bounded reads:
  `journalctl --user -u manga-reader.service -n 300 --no-pager`
- For a time window:
  `journalctl --user -u manga-reader.service --since '20 min ago' --until now --no-pager`
- To follow live logs:
  `npm run logs`
- If a user describes a recent interaction, search the bounded log output for the manga/chapter IDs and frontend event names such as `reader-open`, `chapter-images-result`, `reader-prepend-ok`, `reader-append-ok`, `progress-save`, `reader-close`, `manga-entry-state`, and `view-push`/`view-pop`.

## Specs

- Root `decisions.md` holds both app-level product decisions and technical constraints.
- Read root `decisions.md` before investigating/debugging regressions, designing fixes, or adding features.
- `packages/extensions/providers/comix/business.md` holds provider-specific product rules.
