# Goal: Implement Architecture Audit Ownership Fixes

## Objective

Use `reports/architecture-audit-2026-06-05/index.html` as the evidence anchor
and implement the highest-confidence ownership tightenings in batches. Each
batch should leave the app runnable and observable, and should avoid behavior
rewrites beyond the ownership boundary being fixed.

## Evidence Anchor

- Report folder: `reports/architecture-audit-2026-06-05/`
- Main finding: restarts work around real state leaks because durable queue,
  browser/runtime, and foreground UI ownership are not fully self-healing.
- Highest-confidence observed leak: stale `running` jobs in provider SQLite
  durable queues.

## Constraints

- Evidence first; label inferences.
- No monkey patches, broad gates, or timer-only fixes.
- Prefer one writer per resource/state domain.
- Work in batches so this goal survives compaction.
- After each implementation batch, build/restart with repo scripts if behavior
  changed and check logs.

## Batch Checklist

- [x] Batch 1: DurableQueueReaper
  - Add provider-independent stale `running` job recovery.
  - Log compact reaper decisions.
  - Start/stop it with provider owners, including enabled/disabled transitions.
  - Verify build and service logs.
- [x] Batch 2: Provider runtime state logging
  - Add explicit provider runtime state transitions (`disabled`, `warming`,
    `ready`, `degraded`, `stopping`) around current ProviderCoordinator and
    BrowserSession lifecycle.
  - Keep behavior stable; this batch is observability/ownership only.
- [x] Batch 3: Foreground cache wait observability
  - Replace swallowed foreground waiter outcomes with typed/logged
    `ready`, `timeout`, `aborted`, or `failed` outcomes.
  - Do not change stale-cache serving semantics yet.
- [x] Batch 4: Reader ownership extraction plan
  - Audit current scroll/progress command sites and decide whether a mechanical
    ScrollOwner/ProgressOwner extraction is safe now or should be a later
    dedicated session.
- [x] Batch 5: Restore backing-root ownership
  - Treat root restore as a layer preparation contract, not a swipe-triggered
    side effect.
  - Favorites root preparation now owns IDB rows, card snapshot repair, and
    cached cover warmup when it is restored behind manga/reader.
  - Search restore failures must be fixed in the backend search owner, not
    hidden by stale frontend results.
  - Comix search transport now has a provider-declared runtime API fallback
    when the raw backend fetch path fails.

## Batch Results

- Batch 1 implemented `CacheDatabase.recoverExpiredRunningJobs()`,
  `DurableJobScheduler.recoverExpiredRunning()`, and a provider cache-service
  reaper that runs immediately and every 60s while the provider is enabled.
  This fixes the confirmed stale `running` job ownership leak without depending
  on a matching job claim path.
- Batch 2 added provider runtime state as backend-owned telemetry:
  `disabled`, `warming`, `ready`, `degraded`, and `stopping`. It logs compact
  transitions from `ProviderCoordinator` and exposes `runtimeState` in provider
  summaries without changing the current provider UI behavior.
- Batch 3 replaced swallowed foreground cache wait outcomes with typed
  `notified`, `timeout`, `aborted`, and `failed` outcomes for manga-detail and
  chapter-image waits. Serving semantics are unchanged; logs now show why a
  foreground wait yielded.
- Batch 4 audit found reader scroll/progress extraction is not safe as a small
  mechanical change in this backend batch. DOM scroll writes are still in
  `Reader.svelte`; progress writes come from open, visible-page tracking, and
  close. Extracting `ScrollOwner`/`ProgressOwner` should be a dedicated reader
  session because it crosses restore, projection, progress, and image loading.
- Batch 5 fixed a restore layering leak. Logs showed `restore-root` started
  immediately for favorites/search, but favorites declared itself done after
  IDB rows while cached covers loaded much later on swipe, and search restore
  could surface a backend `/api/search` 500. The fix separates normal
  favorites activation from restore root preparation, and moves Comix search
  fallback into the provider-owned backend search transport.

## Done Decisions To Move To `decisions.md`

- Restore roots have an explicit preparation contract. A backing root must not
  wait for swipe-back before doing the data work needed for immediate display.
- Search 500s are backend transport bugs. Do not hide them with stale frontend
  results; fix the provider search owner and log the chosen transport.
