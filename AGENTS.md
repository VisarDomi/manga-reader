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

## Specs

- Root `decisions.md` holds both app-level product decisions and technical constraints.
- `packages/extensions/providers/comix/business.md` holds provider-specific product rules.
