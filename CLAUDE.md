# Manga Reader

Monorepo (npm workspaces). 4 packages: provider-types, extensions, server (port 29760), app (SvelteKit PWA, Svelte 5).

## First Thing: Read Both business.md Files

Before writing any code or tests, read BOTH business.md files — they are the source of truth:
- `business.md` (root) — app-level product rules (AA through BK)
- `packages/extensions/providers/comix/business.md` — comix provider rules (1–9)

## Spec Hierarchy

The hierarchy is strict and one-directional:

1. **`business.md`** — the goal. What the product should do. Never references code.
2. **`tests/*.md`** — contracts derived from business.md. Describes inputs, outputs, and assertions without naming implementation classes or functions.
3. **Test files** — how the app should look. Written to match contracts. If tests are red, the app code is wrong.
4. **App code** — the implementation. Shaped by tests, not the other way around.

If a test fails, fix the code. Never modify business.md or contracts to match code. Never treat existing code as sacred.

## Test Spec Files

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

Reference books in `resources/` — Kent Beck (TDD), Freeman & Pryce (GOOS), Feathers (Legacy Code), Khorikov (Unit Testing), Seemann & van Deursen (DI).

## Testing Rules

Source of truth chain: `business.md` → `tests/*.md` → test files. If a test fails, the code is wrong. Never modify specs to match code.

Workflow per test — do ONE at a time, get approval before the next:
1. Read the business rule in business.md
2. Read the test description in the relevant `tests/*.md` file
3. Write the `contract` block in `tests/*.md` FIRST — this drives the test
4. Write the test to match the contract
5. `npx vitest run` — red tests are expected and valuable
6. Commit referencing the T-XX-N ID

Do NOT:
- Write tests without a contract in `tests/*.md` first (Beck: Red before Green)
- Test implementation details — only test observable behavior that business rules demand (Khorikov: observable behavior vs implementation details)
- Create test files for utility classes (ToastState, UIState, etc.) unless a business rule specifically requires it
- Inflate test count with trivial assertions (e.g. "show() adds an item" is testing assignment, not behavior)
- Write contracts after tests — that's rubber-stamping, not driving design (GOOS: outside-in)
- Treat existing code as sacred — if business.md says X and the code does Y, the code is wrong
- Batch many tests in one pass — small batches allow the user to audit
- Use string literals when a constant exists — use `ErrorKind.NETWORK` not `'network'`, `ApiErrKind.HTTP` not `'http'`. This applies to test data, assertions, object construction — everywhere

## Three Phases

The app is being rewritten. The phases are strict — finish each before starting the next:

1. **Pin (current phase):** Write unit tests for every contract in `tests/*.md`. Red tests are expected — they document what the code must do. Do NOT touch app code to make tests pass. Do NOT implement features. Constants and types are OK to add/modify.
2. **Rewrite:** Make all tests green by rewriting app code. Implement missing features (BH data isolation, BG repos, BA dynamic timeout, etc.). This is where code changes happen.
3. **Integration & E2E:** After the rewrite, add tests that need real infrastructure:
   - **Integration tests** (real HTTP, real server): T-BJ proxy, T-BK TLS, T-BQ cache headers.
   - **E2E tests** (real browser/DOM): T-AS cover-only cards, T-AT-4 gesture snap, T-AO-4 swipe animation, T-AC-5 non-blocking UI.

## Test Helpers

Shared test infrastructure in `packages/app/src/lib/test-helpers/`:
- `storage-fake.ts` — in-memory Map-based storage fake, used by search, filter, and reader tests
