# Manga Reader

## Svelte 5 Pitfalls

IMPORTANT: Before writing or modifying any `.svelte` or `.svelte.ts` file, read BOTH of these:
- [svelte5-pitfalls.md](/home/visar/.claude/projects/-home-visar/memory/svelte5-pitfalls.md) — quick rules
- [svelte5-pitfalls-detail.md](/home/visar/.claude/projects/-home-visar/memory/svelte5-pitfalls-detail.md) — detailed explanations with code examples

Monorepo (npm workspaces). 4 packages: provider-types, extensions, server (port 11555), app (SvelteKit PWA, Svelte 5).

## Server Management

The server runs as a systemd user service (`manga-reader.service`) wrapped in `xvfb-run` — Playwright/CloakBrowser needs a virtual display for Cloudflare solving.

- **Never** kill the server process directly or start it with `nohup`/`node`/`tsx`
- **Always** use systemctl:
  - `npm run restart` (or `systemctl --user restart manga-reader`)
  - `npm run stop` / `npm run start` / `npm run status` / `npm run logs`
- These scripts are defined in `packages/server/package.json`

## business.md Files
- `business.md` (root) — app-level product rules (AA through BK)
- `packages/extensions/providers/comix/business.md` — comix provider rules (1–9)

## Spec Hierarchy

The hierarchy is strict and one-directional:

1. **`business.md`**
2. **`tests/*.md`** — contracts derived from business.md. Describes inputs, outputs, and assertions without naming implementation classes or functions.
3. **`*.test.ts` files** — how the app should look
4. **App code** — the implementation

