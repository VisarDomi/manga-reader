# Manga Reader

Monorepo (npm workspaces). 4 packages: provider-types, extensions, server (port 29760), app (SvelteKit PWA, Svelte 5).

## Spec Files

Two `business.md` files — both are sources of truth:
- `business.md` (root) — app-level product rules (AA through BK)
- `packages/extensions/providers/comix/business.md` — comix provider rules (1–9)

One `test.md` (root) — test descriptions and contracts for all rules.

