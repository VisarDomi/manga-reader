# Manga Reader: third native fidelity pass

September 13, 2026. The userscript/extension source remains the behavioral
reference. This pass started with a Scythe Home row flashing after reading a
chapter and returning. The earlier pass proved that *unchanged* rows survived
catalog batches, but did not test a progress/chapter change in the same row.

## Corrections

- Native Home compared the entire serialized series/progress and replaced a
  changed article, including its cover image. It now compares rendered values,
  retains the article/cover, and replaces only changed chapter-list content.
  Progress timestamps and JSON property order do not trigger DOM updates. Actual
  cover URL changes request new bytes without replacing the image element.
  The source's Back/history reconciliation already patches links in place;
  its duplicate-page chapter merging can replace a row. The requested native
  list-only update applies to both native paths.
- A completed native Home document used to restart the whole catalog on Back
  and foregrounding. It now keeps its completed catalog, like the source Home
  lifecycle. A new document/cold launch fetches again. An interrupted or failed
  native refresh can retry; cached rows remain available while it catches up.
  Current-plus-next preparation still runs for the updated local reading state.
- Cover loading feedback is cleared on a persisted pageshow, matching the
  source's transient-link reset. Returning after an unsuccessful open can retry.
- Appending/preloading Next no longer changes the reader title to a chapter
  that is not visible. Title changes follow the tracked visible chapter, using
  its actual provider ID and title. Tracking requires a completed image load,
  matching the source's imageLoaded predicate.
- Identical native checkpoints no longer rewrite state on every image callback.
  Fractional movement still saves. Failed native progress writes and provider
  tracking now show the source's single `Progress sync failed` message.
- Native Asura omitted source account-history and chapter-tracking requests.
  Optional requests now use its existing local session/serialized refresh path;
  the UI imports the source's actual remote-history parser and resolver. Tracking
  makes the source bookmark/read and view calls once per visible chapter.
  Without local credentials these operations are no-ops. No login UI, credential
  import, real-account mutation test, or automatic PC history sync was added.
- Next previously trusted the chapter-list lock flag and could reject a chapter
  that had since unlocked. Its actual chapter response now decides. Explicit
  locked/404 responses show `Chapter unavailable` while keeping current pages;
  transport/malformed responses remain failures. Unexpected appended identities
  are rejected. Native initial-open errors remain on an app error page, since
  there is no original-site series page to navigate to.
- Wrong-provider PC progress used to be filtered out, turning an invalid Load
  into an empty replacement. It now rejects that backup, as the source does,
  and rejects repeated normalized identities. Intentional empty same-provider
  Loads and existing local-session retention are preserved.
- Scythe catalog labels/series URLs and relative-date casing now follow the
  source's rules; non-chapter labels do not invent chapter links. Yaksha's full
  chapter list follows the source's chapter-label IDs/filter and supplied order.
- A stale native document's `ready` message can no longer restart Home work;
  navigation invalidates its document identity before accepting the next page.

## Review coverage and retained app boundaries

| Area | Reference reviewed | Native boundary |
| --- | --- | --- |
| Home rows, history overlay, paging, locks, dates, link feedback | src/routes/home.ts; core/home-format.ts; compute/history.ts | Cached initial Home, First chapter, native local links; shared CSS and history/time helpers |
| Reader loading, Next, failures, current image, title, retry, input cancellation | src/routes/reader.ts; core/tracking.ts; image-retry.ts; scroll-settle.ts | Accepted bounded image slots, fractional cold restore and lifecycle checkpoints; no SOC |
| Provider data and ordering | All six src/provider adapters/catalog helpers | Swift parses network data; pages never run provider website JavaScript |
| Progress, manual PC Load/Save, provider isolation | compute/progress.ts; backup/store/manual-pc.ts; home-backup.ts | App cache/history/fraction metadata retained; PC availability is silent and never transfers history |
| Native lifecycle, HTTP, cache, preparation/pruning | Source lifecycle/tracking and agreed app requirements | Same app identity, current-plus-next image window, retained reading state; paused downloads/catalog retry when Home returns |

The native cache/slot mechanics, First chapter, fractional restart, and manual PC
pipeline are prior explicit app requirements. They are not removed by this pass.
All-image non-selection/callout CSS remains shared. No AGENTS.md, README.md or
test.txt content was authored as part of this work.

## Validation

- Enhanced browser fixtures pass for all six providers: completed chapter → Home
  overlay, row/cover identity, equivalent snapshot mutation count, cover refresh,
  Back loading reset, title, unchanged-checkpoint suppression, once-per-chapter
  tracking, visible write failures, account-only overlay, stale lock flags and
  actual unavailable chapters, plus the existing restore/navigation/cache tests.
- Running those fixtures against the previous committed Web assets fails at
  `finishing a chapter retains row and cover`.
- Shared source unit tests: 34 passed. Provider-builder and signing-lock checks pass.
- Mac Swift tests pass cache/prune/offline/checkpoint behavior, wrong-provider Load
  without state loss, parser parity, optional account requests, concurrent 401s
  sharing one refresh, tracking endpoints and unavailable continuation.
- Live catalog, chapter-list, manifest and image checks pass for all six providers.
- The user manually tested the updated Scythe app and confirmed it looks correct.
  Device delivery evidence is recorded with the final build receipts.
  Fixture account tests do not claim real authenticated Asura account acceptance.

## Final delivery

All six native providers were installed in place at build 4 and passed their
renewal checks. Scythe's temporary Home listener observed five updates and two
persisted Back restores with zero row or cover replacements. The listener was
removed after saving the Home checkpoint. The monthly scheduler is active and
the temporary build job is removed. See
[the delivery receipt](third-port-fidelity-verification.json).
