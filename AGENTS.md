# Manga Reader

Monorepo (npm workspaces). Packages: `provider-types`, `extensions`, `server`, `app` (SvelteKit PWA, Svelte 5).

## Current Direction

- The server-side PWA is paused in favor of the Comix userscript app under
  `~/Documents/environment/browser/userscripts/comix`.
- Treat this repo as read-only reference material unless the user explicitly
  asks to change the server-side PWA.
- The parts worth preserving as reference are documented in `decisions.md`,
  especially reader geometry/ownership, chapter filtering, restore/session
  ownership, Comix runtime data access, and logging discipline.

## Read on demand

- Frontend app:
  `~/Documents/work/manga/manga-reader/packages/app/AGENTS.md`

## Server management

- Main service port: `11555`
- The server runs as the systemd user service `manga-reader.service`, wrapped in `xvfb-run`.
- Check out package.json to see the commands to build/restart and other scripts.

## Logs

- Start debugging by checking the managed service logs.
- Use direct `journalctl` for bounded reads:
  `journalctl --user -u manga-reader.service -n 300 --no-pager`
- For a time window, usually the specific time after a build so that you get the logs from the user tests:
  `journalctl --user -u manga-reader.service --since '2026-05-09 01:13:00' --until now --no-pager`
- If a user describes a recent interaction, search the bounded log output for the manga/chapter IDs and frontend event names such as `reader-open`, `chapter-images-result`, `reader-prepend-ok`, `reader-append-ok`, `progress-save`, `reader-close`, `manga-entry-state`, and `view-push`/`view-pop`.

## Specs

- Root `decisions.md` holds both app-level product decisions and technical constraints.
- Read root `decisions.md` before investigating/debugging regressions, designing fixes, or adding features.
- If `goal.md` exists, read it after `decisions.md`; it records the active unfinished task and should be treated as the handoff point after compaction.
- For Svelte 5 behavior, first read `~/Documents/memory/svelte5-pitfalls.md`; when it is unclear or may be stale, reference the official docs snapshot in `~/Documents/reference/svelte-5-docs/`.
- `packages/extensions/providers/comix/business.md` holds provider-specific product rules.
