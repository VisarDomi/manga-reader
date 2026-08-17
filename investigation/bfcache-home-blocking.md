# BFCache restore blocks the home main-thread UI — investigation

Symptom: swiping back from reader → home (bfcache restore) leaves home unresponsive;
it appears to "wait for updates".

## What fires on restore (home page)

On bfcache restore, `visibilitychange`(visible) and `pageshow`(persisted) fire. On the
home page this synchronously and asynchronously triggers several "update" pipelines at once:

1. `resume()` (src/routes/home.ts:417-429) — wakes the catalog pagination loop
   (`while (nextCursor !== null)`, home.ts:524-548). After ~1s the loop resumes
   `fetchHome` and keeps churning **until the entire catalog is loaded**, one
   `appendPage` per page (50 series/page asura, 100 valir — src/provider/asura.ts:126,
   src/provider/valir.ts:179).
2. `reconcilePageShow` (home.ts:514-518) — synchronous on every pageshow:
   - `reconcileProgress` → `applyHistoryLayers` → `getProviderProgress` →
     `readProgress()` (src/storage/progress.ts:28-36): `localStorage.getItem` +
     `JSON.parse` + per-entry validation of the **entire** progress store.
   - `applyHistory` (home.ts:255-376): full-catalog DOM pass.
   - `reconcileRemoteHistory` (home.ts:502-513): async fetch (asura
     /me/read-chapters, valir /api/continue-reading); on completion runs
     `applyHistoryLayers` again — a second full pass.
3. Token managers `pageshow` handlers (src/provider/asura-token-manager.ts:103,
   src/provider/valir-token-manager.ts:131) — async refreshes (minor).
4. Perpetual 1s image-retry loops (src/core/shell.ts:48-51, 68-69) — the
   `.hs-home-cover img` loop scans **every cover** every 1000 ms forever (even with
   zero failures) and resets `img.src` on broken covers each tick.

## Why the main thread is blocked

- **O(N×M) per pass:** `applyHistory` runs `progress.filter(item => item.seriesSlug ===
  seriesSlug)` for **every card** (home.ts:268). With ~800 catalog cards × ~1000 stored
  progress entries that is ~800k iterations plus ~4k DOM class/href writes **per pass**.
- **The full pass runs repeatedly in a burst:** once synchronously inside `pageshow`,
  again when remote history arrives, and once after **every** resumed catalog page
  (home.ts:487 — `appendPage` re-applies history to the whole list, not just new cards).
- **No yielding anywhere:** no time-slicing / `requestIdleCallback` / chunking in
  `appendPage` or `applyHistory`; a 50-100 card page renders ~1-2k DOM nodes
  synchronously, and the loop continues after a fixed 1s delay (POLITE_PAGE_DELAY_MS,
  home.ts:15) until the whole catalog is done.
- **`readProgress()` re-parses the whole store per call** (called from every
  `applyHistoryLayers`, i.e. every pageshow + every remote-history completion).
- The 1s retry loop adds constant background main-thread churn on home.

Net effect: right when the user swipes back, several tens-of-ms synchronous DOM/JSON
passes fire back-to-back and keep firing as the catalog "catches up" — the main thread
(UI) is saturated, so scrolling/taps queue: "not responsive, waiting for updates".

## Related (reader direction, same family)

- Reader `pageshow` → `scrollEndOneHundred` (src/routes/reader.ts:218) →
  `tracker.track` → `saveChapterProgress` (src/storage/progress.ts:67-69) does a full
  synchronous read-modify-write of the whole progress store on every restore/scrollend.
- Lifecycle wiring itself is sound: `pause`/`resume` + lifecycleVersion retry is
  correct and tested (tests/unit/home-providers.test.ts:488-510); the problem is **what
  runs synchronously on resume**, not the pause/resume mechanism.
- shell.ts:73-77 correctly skips provider teardown on persisted pagehide. Not a problem.

## Suggested fix directions (design only — not implemented)

1. Index progress by `seriesSlug` once per pass (Map) — removes the N×M filter.
2. Apply history only to newly appended cards instead of re-scanning the whole catalog
   after every page.
3. Time-slice card rendering (chunked async / `requestIdleCallback`) so resumed
   pagination yields to input.
4. Cache the parsed progress store in memory; async, debounced writes.
5. Debounce pageshow-triggered reconciles (skip when a pass is queued/in flight);
   defer the post-restore catalog catch-up to idle/first interaction.
6. Retry loops: schedule only while there is actual broken/incomplete work (dirty flag),
   and/or use IntersectionObserver instead of scanning every cover each second.
