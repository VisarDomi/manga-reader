# Manga Reader

Monorepo (npm workspaces). 4 packages: provider-types, extensions, server (port 29760), app (SvelteKit PWA, Svelte 5).

## Spec Files

Two `business.md` files — both are sources of truth:
- `business.md` (root) — app-level product rules (AA through BK)
- `packages/extensions/providers/comix/business.md` — comix provider rules (1–9)

Test specs in `tests/` folder — split by domain:
- `tests/_types.md` — domain types (shared reference)
- `tests/search.md` — filters, search, pagination, scroll trigger (AA, AB, AC, AD, AE, AS)
- `tests/chapters.md` — chapter groups, progressive loading (AF, AG)
- `tests/reader.md` — progress, prefetch, windows, images, cleanup, restore (AH–AK, AL, BL, BM, BN, BO, BP, BQ)
- `tests/favorites.md` — favorites, db errors (AM, AN, BR)
- `tests/navigation.md` — view stack, swipe gesture (AO, AT)
- `tests/session.md` — snapshot, restore, cold/warm resume (AP, AQ, AR, AU, AV)
- `tests/errors.md` — error types, display, retry, watchdog, boot (AX, AY, AZ, BB, BC, BD)
- `tests/providers.md` — timeout, storage, repos, isolation, loading, cloudflare (BA, BE, BF, BG, BH, BI, AW)
- `tests/server.md` — proxy, TLS (BJ, BK)
- `tests/comix.md` — comix provider (C1–C9)

Root `test.md` has been removed — use `tests/` folder.

Reference books in `resources/` — Kent Beck (TDD), Freeman & Pryce (GOOS), Feathers (Legacy Code), Khorikov (Unit Testing), Seemann & van Deursen (DI).

## Testing Rules

Source of truth chain: `business.md` → `tests/*.md` → test files. If a test fails, the code is wrong. Never modify specs to match code.

Workflow per test — do ONE at a time, get approval before the next:
1. Read the business rule in business.md
2. Read the test description in the relevant `tests/*.md` file
3. Write the `contract` block in `tests/*.md` FIRST — this drives the test
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

## Known-Failing Tests (blocked on BH — repo/provider scoping)

These tests are written to the spec but fail because the multi-repo/provider infrastructure doesn't exist yet. All BH-scoped data (progress, favorites, filters, group blacklist, response times) currently uses flat keys (e.g. `manga.id`) instead of composite keys (`repoUrl:providerId:mangaId`). Do NOT "fix" these tests to match current code — fix the code when the repo feature is built.

- **T-AH-1** (`reader.test.ts`): Progress key must be `repoUrl:providerId:mangaId`, not bare `manga.id`
- **T-AA-3** (not yet written): FilterState NSFW seeding must be per-provider, not global `'filters'` key

## Tech Debt

- **logic.ts is an orphan grab-bag**: Pure functions (`cycleGenreFilter`, `filteredChapters`, `isTransient`, etc.), constants (`VALID_STACKS`, `READER_ROOT_MARGIN`), and types (`AppError`, `ViewStack`) are all in one file. Some functions are duplicated in state classes (e.g. `filteredChapters` in logic.ts vs `MangaState.filteredChapters`). Needs refactoring when the app is restructured — move functions closer to their consumers or into domain modules.
- **T-AG-2/3 blocked on extraction** (`api.test.ts`): Dedup + partial-failure logic is inside `fetchChapterList` in `api.ts`. Tests target `mergeChapterPages` — a pure function that should be extracted to `logic.ts` (same pattern as `filteredChapters`). Tests are `it.fails` until the extraction happens.

