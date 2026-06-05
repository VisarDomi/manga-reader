# Goal: Architecture Polish And Provider Boundary Tightening

## Objective

Polish the manga-reader architecture so hard edge cases stay handled with less
incidental complexity. Add code only when it owns a real edge case. Prefer
smaller command/resource owners over larger hub classes, but do not refactor for
cosmetic reasons.

This goal is the handoff point after the two architecture reports:

- `reports/architecture-audit-2026-06-05/`
- `reports/architecture-bloat-2026-06-05/`

## User Position

- The app must keep: local PWA behavior, iOS Safari fast infinite reader scroll,
  cache-first data serving, provider quirks, thumbnails/covers, comments,
  restore/back layers, and foreground priority.
- The user did not identify an unwanted feature from the second report. The
  bloat feeling comes from too many real requirements being coupled in large
  owners.
- Do not add wrappers or gates as "architecture." A real architecture fix
  clarifies authority: one writer, one owner, typed commands, explicit state.
- Tight coupling is acceptable when ideas are truly one domain. Decouple only
  when two different ideas are forcing each other to change.
- Large files are not automatically bad. Extract command owners only where a
  bug history or evidence proves a boundary.
- New larger feature direction: provider-specific knowledge should eventually
  move out of this monorepo into provider packages loaded from an external
  source, similar in spirit to Tachiyomi/Tachimanga extension repos such as
  Keiyoushi. The monorepo should become a provider host, not a place where every
  provider quirk lives forever.

## Evidence Baseline

Known already improved since the first architecture audit:

- Durable queue recovery exists:
  `CacheDatabase.recoverExpiredRunningJobs()`,
  `DurableJobScheduler.recoverExpiredRunning()`, and a provider cache-service
  reaper.
- Provider runtime state is logged as `disabled`, `warming`, `ready`,
  `degraded`, `stopping`.
- Foreground cache wait outcomes are typed/logged as `notified`, `timeout`,
  `aborted`, or `failed`.
- Restore backing-root ownership was tightened: hidden root preparation now
  prepares favorites/search roots before swipe-back.
- Comix search 500 fallback moved to backend provider search transport instead
  of stale frontend fallback.

Open evidence questions to re-check before implementation:

- Are stale `running` jobs still present after the reaper has had time to run?
- Is Mangadot disabled as intended when only Comix is enabled?
- Are background data/cache failures still capable of degrading foreground
  browser/runtime work?
- Are reader scroll/projection/progress writes still split enough to cause
  ownership bugs?
- Are current logs compact enough to prove foreground/background arbitration?

## Phase 0: Re-Verify First Report Findings

Before changing code, answer these with logs/SQLite/code:

- [x] Check current provider settings and prove enabled providers. Expected now:
  only Comix enabled unless user changed settings.
- [x] Query both provider SQLite queues for stale `running` or expired leased
  jobs. Compare to first-report examples:
  `cache-chapter-page-map:jlnve:8793582` and
  `cache-manga-detail:18556`.
- [x] Verify durable reaper logs or DB state prove stale running jobs are
  reclaimable without service restart.
- [x] Check if background page-map failures are still frequent and whether they
  share browser/runtime resources with foreground work.
- [ ] Check foreground cache wait logs for typed outcomes; no swallowed waits.
- [x] Check current browser surface logs for runtime health, pages, renderers,
  CPU, RSS.
- [x] Summarize: fixed, partially fixed, still open, or obsolete.

Phase 0 summary from 2026-06-05 12:18 verification:

- Fixed: Comix active worker recovery runs on startup (`recovered-running
  worker=cache-service:comix jobs=1`) and current Comix `running` work had a
  fresh lease.
- Fixed in this batch: disabled-provider expired leases are recovered without
  starting provider work. Mangadot `cache-manga-detail:18556` moved from stale
  `running` to `retry` while logs still showed
  `provider-disabled provider=mangadotnet action=skip-start`.
- Still open: background Comix `cache-chapter-page-map` work produces provider
  404/timeout failures through the same BrowserSession runtime lane as cache
  work, so foreground/background arbitration still needs Phase 2 audit.
- Still open: no recent foreground cache waits occurred in the verification
  window, so typed foreground wait behavior remains to verify on a user flow.

Useful commands:

```bash
systemctl --user show manga-reader.service -p ActiveState -p SubState -p MainPID -p ExecMainStartTimestamp --no-pager
journalctl --user -u manga-reader.service --since '<last restart>' --until now --no-pager \
  | rg "runtime-state|reaper|recovered|foreground-cache-wait|cache-job|background|provider-disabled|browserSession|surface|failed|timeout"
sqlite3 /home/visar/.local/state/manga-reader/cache.sqlite "
select kind,status,priority,count(*) from cache_jobs group by kind,status,priority order by count(*) desc limit 30;"
sqlite3 /home/visar/.local/state/manga-reader/cache.sqlite "
select id,kind,status,priority,resource_key,lease_owner,datetime(lease_until/1000,'unixepoch','localtime'),substr(last_error,1,180)
from cache_jobs
where status='running' or (lease_until is not null and lease_until < strftime('%s','now')*1000)
order by updated_at asc limit 40;"
cat /home/visar/.local/state/manga-reader/provider-runtime.json
```

## Phase 1: Durable Queue And Runtime Recovery Tightening

Goal: restart should not be the primary recovery mechanism.

- [x] If stale `running` jobs still exist, fix the reaper/claimer so expired
  leases are recovered regardless of provider enabled state, suspended state,
  or current job-kind filters.
- [x] Make durable recovery decisions compact and visible:
  recovered count, oldest lease age, sample resource keys, provider id.
- [ ] Classify persisted runtime/provider failures by provider runtime
  generation so stale runtime-drift errors do not remain authoritative after
  browser/runtime recovery.
- [x] Ensure disabled providers do not consume browser/cache/byte work, but
  their stale durable rows are still observable and recoverable when needed.

Do not:

- Do not reset/clear jobs wholesale without understanding ownership.
- Do not add a restart-only repair path.

## Phase 2: Foreground/Background Arbitration

Goal: visible user intent must not wait behind speculative background work.

- [x] Audit `CacheService`, `BrowserSession`, `ByteCacheService`, and provider
  runtime lanes for shared foreground/background resources.
- [x] Define explicit foreground request authority:
  serve cached data immediately when present; enqueue/promote refresh; subscribe
  to resource-ready only when the UI actually needs to wait.
- [x] Define explicit background crawler authority:
  can consume idle capacity; must yield when matching or higher-priority
  foreground work arrives; must not mark provider runtime unhealthy in a way
  that blocks foreground unless the provider is truly broken.
- [ ] Replace any remaining swallowed wait/timeout paths with typed results:
  `ready`, `stale-refreshing`, `warming`, `failed`, `aborted`, `timeout`.
- [ ] If needed, split `CacheService` by resource ownership only where it
  reduces policy coupling:
  `MangaDataCache`, `ChapterImageMetadataCache`, `FilterCatalogCache`,
  `StoreSelectionPolicy`, all using one durable queue.

Phase 2 batch from 2026-06-05:

- Implemented explicit data-cache lanes inside `CacheService`: foreground
  claims `observed`/`foreground`/`interactive`; background claims only
  `daily`/`background`.
- One durable queue remains the source of truth; lane-specific worker ids make
  running work observable without adding separate queues.
- Background does not claim while higher-priority work is runnable or while the
  provider runtime is unhealthy. This addresses the proven coupling where a
  slow background page-map job could occupy the single data worker even though
  BrowserSession had separate browser lanes.
- Still open: verify foreground cache waits on a user flow, and only split
  BrowserSession/CacheService further if later logs prove more resource
  coupling.

Do not:

- Do not add a global cooldown/gate unless evidence proves no better ownership
  boundary exists.
- Do not make foreground wait for background page-map ingestion.

## Phase 3: Reader Scroll / Projection / Progress Ownership

Goal: prevent scroll leaks without rewriting the bounded scroller.

Target command owners:

- `ScrollOwner`: the only code allowed to write DOM scroll positions.
- `ProjectionOwner`: owns logical-to-physical projection and rebase eligibility;
  can request a scroll transaction but cannot directly write DOM.
- `ProgressOwner`: accepts `open`, `visible`, `close`, and `swipe-back` commands
  and serializes progress writes.
- `ImageVisibilityOwner`: owns critical vs preload image loading and visibility
  guarantees for the reader's physical window.

Checklist:

- [ ] Audit all DOM scroll writes in `Reader.svelte`, manga detail restore,
  search restore, and swipe/restore code.
- [ ] Audit all `db.setProgress`, `progress.update`, and progress-save paths.
- [ ] Decide whether scroll/progress extraction is justified now by current
  bugs/logs or should stay coupled until the next confirmed leak.
- [ ] If justified, extract one owner at a time, with logs proving command
  input/output and no new gates.
- [ ] Preserve known-good reader constraints:
  bounded physical window, iOS Safari momentum, native `scrollend + 100ms`
  rebase policy, cache/decoder priority for visible images.

Do not:

- Do not add timer-based truth. Timers may debounce observation, but state
  transitions need logged reasons.
- Do not let multiple code paths write DOM scroll as a "small fix."

## Phase 4: Root Restore Owner

Goal: make restore layering explicit and make `AppState` thinner only if it
reduces branch complexity.

Expected restore model:

1. Restore the foreground shell immediately.
2. Ask that foreground owner to prepare its UI state.
3. Prepare backing layers in stack order while hidden.
4. Root is exclusive: search, favorites, or providers, not multiple roots.
5. Each feature owns its own pending scroll/data readiness.

Checklist:

- [ ] Audit current `AppState` restore/root methods after the latest fixes.
- [ ] If extraction reduces code, create `RootRestoreOwner` with typed commands:
  foreground, backing layers, root kind, target id, search context.
- [ ] Keep feature-specific prep in feature owners:
  favorites prepares IDB rows + snapshots + cover warm;
  search replays search context;
  manga restores per-layer scroll;
  reader restores projection/progress.

Do not:

- Do not make restore wait for image bytes.
- Do not serve stale search results on backend error.

## Phase 5: BrowserSession Responsibility Split

Goal: keep the warm browser runtime, but stop one class from owning every
browser lifecycle and provider transport policy.

Current coupled responsibilities:

- browser context lifecycle
- foreground/background runtime pages
- fetch through site runtime
- provider page parsing helpers
- runtime health/context reset
- decoder integration
- browser surface CPU/RSS logging

Potential split only if it reduces policy coupling:

- `BrowserContextOwner`: launch/destroy/recover context.
- `RuntimeHttpOwner`: foreground/background lanes and runtime fetches.
- `RuntimeHealthOwner`: challenged/degraded/ready state and generation.
- `ScrambledDecodeOwner`: warm decoder and critical decode queue.
- Provider capability object decides which runtime owner it needs.

Do not:

- Do not split mechanically if the result is more files with the same hidden
  coupling.

## Phase 6: Provider Boundary / External Provider Packages

Goal: move toward a host/extension architecture where provider-specific
knowledge can live outside this monorepo and be loaded from a configured source,
similar in spirit to Tachiyomi/Tachimanga extension repositories.

Exploration questions:

- [ ] What provider-specific code exists today in:
  `packages/extensions/providers/*`,
  `packages/server/src/providers/*`,
  `BrowserSession`,
  `CacheService`,
  `ByteCacheService`,
  search/comments/cache routes,
  and frontend provider state?
- [ ] What would be the minimal provider package contract?
  Search request/parse, manga detail, chapter list, chapter image metadata,
  comments, filters, cover/image byte rules, runtime requirements, scramble
  rules, Cloudflare/challenge behavior.
- [ ] Can provider packages be loaded safely from a Git URL/build artifact?
  Decide between npm package, git checkout + build, or local extension folder.
- [ ] How would versioning and cache invalidation work when a provider package
  updates?
- [ ] How does this interact with the current `provider-types` package?

Likely target:

- Core app owns UI, restore, cache engine, durable queue, browser host, byte
  cache, and provider registry.
- Provider package owns provider-specific URLs, parsers, runtime capabilities,
  comments identifiers, filters, image candidate rules, and scramble/decoder
  declarations.
- Core never checks `provider.id === 'comix'` for behavior except compatibility
  migration or display.

Do not:

- Do not implement external provider loading before the internal provider
  capability boundary is clean enough to host it.
- Do not introduce dynamic remote code execution casually; define trust and
  update model first.

## Phase 7: Logging Compaction And Decision Logs

Goal: keep logs powerful but compact.

- [ ] Keep aggregate summaries for cover/image/card loads; avoid per-item spam.
- [ ] Add compact decision logs for arbitration:
  foreground requested, background yielded, runtime degraded, stale served,
  refresh subscribed, refresh completed.
- [ ] Ensure logs can answer:
  why did UI wait?
  who owned the provider runtime?
  did background work compete?
  who wrote scroll?
  who wrote progress?
- [ ] Remove zombie/stale event names after ownership changes.

## Phase 8: Documentation / Decisions Hygiene

After each accepted batch:

- [ ] Move durable decisions from this file to `decisions.md`.
- [ ] Keep only unfinished work in `goal.md`.
- [ ] Update or remove report/plan files once they become stale.
- [ ] Build/restart with package scripts for behavior changes:

```bash
npm run build
npm run restart
```

## Completion Definition

This goal is complete when:

- stale durable running work is self-healing and observable;
- foreground work cannot be trapped behind background crawling;
- reader scroll/progress writes have explicit single-writer ownership or are
  intentionally left coupled with evidence;
- restore/root behavior is explicit and `AppState` is no longer the default
  place for every restore branch;
- provider-specific policy is ready to move toward extension packages;
- logs prove the above without overwhelming future model context.
