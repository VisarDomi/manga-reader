# Manga Reader

Monorepo (npm workspaces). 4 packages: provider-types, extensions, server (port 29760), app (SvelteKit PWA, Svelte 5).

## business.md Files
- `business.md` (root) — app-level product rules (AA through BK)
- `packages/extensions/providers/comix/business.md` — comix provider rules (1–9)

## Spec Hierarchy

The hierarchy is strict and one-directional:

1. **`business.md`**
2. **`tests/*.md`** — contracts derived from business.md. Describes inputs, outputs, and assertions without naming implementation classes or functions.
3. **`*.test.ts` files** — how the app should look
4. **App code** — the implementation

