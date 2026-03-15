# Manga Reader

Monorepo (npm workspaces). 4 packages: provider-types, extensions, server (port 29760), app (SvelteKit PWA, Svelte 5).

## Spec Files

Two `business.md` files — both are sources of truth:
- `business.md` (root) — app-level product rules (AA through BK)
- `packages/extensions/providers/comix/business.md` — comix provider rules (1–9)

One `test.md` (root) — test descriptions and contracts for all rules.

Reference books in `resources/` — Kent Beck (TDD), Freeman & Pryce (GOOS), Feathers (Legacy Code), Khorikov (Unit Testing), Seemann & van Deursen (DI).

## Testing Rules

Source of truth chain: `business.md` → `test.md` → test files. If a test fails, the code is wrong. Never modify specs to match code.

Workflow per test — do ONE at a time, get approval before the next:
1. Read the business rule in business.md
2. Read the test description in test.md
3. Write the `contract` block in test.md FIRST — this drives the test
4. Write the test to match the contract
5. `npx vitest run` — must pass clean
6. Commit referencing the T-XX-N ID

Do NOT:
- Write tests without a contract in test.md first (Beck: Red before Green)
- Test implementation details — only test observable behavior that business rules demand (Khorikov: observable behavior vs implementation details)
- Create test files for utility classes (ToastState, UIState, etc.) unless a business rule in test.md specifically requires it
- Inflate test count with trivial assertions (e.g. "show() adds an item" is testing assignment, not behavior)
- Write contracts after tests — that's rubber-stamping, not driving design (GOOS: outside-in)
- Mock at the wrong seam — use the real `ApiError` class from `fetchJson.js` so `instanceof` checks in `toLoadError` work (Seemann: composition root owns the dependency graph)
- Batch many tests in one pass — small batches allow the user to audit

