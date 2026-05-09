# Cache Invalidation and Reconciliation Plan

## Goal

Keep backend cache fresh when live search discovers newer manga data, without
falling back to expensive full recaches for large manga.

The common case is:

1. Live search returns a manga with `latestChapter = 3001`.
2. Backend cached chapter list still has `cachedMax = 3000`.
3. Frontend reports that mismatch to the backend.
4. Backend repairs the cache by fetching only the newest chapter-list pages
   needed to bridge the gap.
5. If the user opens that manga, the same repair work is promoted above normal
   background work.

## Ownership

- **Search owns fresh discovery.** Search is live and can see newer upstream
  max chapter numbers before the cache does.
- **Frontend owns observation, not repair.** The frontend reports evidence:
  manga ID, observed latest chapter, source, and user priority. It does not
  decide how many pages to fetch or how to merge.
- **Backend cache owns truth and repair.** The cache service decides whether
  cached data is stale, what work is needed, how to fetch it, and how to merge
  results.
- **Provider/BrowserSession own upstream details.** Comix request signing,
  pagination shape, IDs, and parsing stay out of UI state.

## New Contract

Add a backend endpoint:

```http
POST /api/cache/manga/:mangaId/reconcile
```

Request body:

```json
{
  "observedLatestChapter": 3001,
  "source": "search-result",
  "priority": "observed"
}
```

Allowed sources:

- `search-result`: live search result noticed newer upstream data.
- `manga-open`: user opened a manga from a result/card.
- `manual-refresh`: explicit user refresh can continue using full refresh if
  desired, but it should log under the same vocabulary.

Allowed priorities:

- `observed`: repair soon, but do not block foreground user work.
- `foreground`: user is opening/reading this manga; promote immediately.

The endpoint should respond quickly with the decision, not wait for all repair
work unless the existing cache read path is already polling for warming.

Example response:

```json
{
  "status": "queued",
  "mangaId": "abc",
  "cachedMax": 3000,
  "observedLatestChapter": 3001,
  "action": "reconcile"
}
```

## Cache Decision Flow

When reconcile is requested:

1. Read existing cached chapter list.
2. Compute:
   - cached max chapter number
   - cached top chapter ID if available
   - cached chapter count
   - cache status
3. If no cached chapter list exists:
   - queue normal `cache-manga-detail`
   - queue normal `cache-chapters`
   - reason: `reconcile-missing-cache`
4. If `observedLatestChapter` is missing or invalid:
   - log and ignore, unless priority is foreground and the cache is missing.
5. If `cachedMax >= observedLatestChapter`:
   - no repair is needed.
   - log `fresh`.
6. If `observedLatestChapter > cachedMax`:
   - queue or promote `reconcile-chapters`.
   - include cached max/top chapter evidence in the job.

The frontend should never delete cache rows or request page numbers directly.

## Incremental Reconcile Strategy

Add a cache job kind:

```ts
reconcile-chapters
```

The job fetches newest chapter-list pages in descending order and merges new
items into the cached list.

Algorithm:

1. Load cached chapter list.
2. Build a set of cached chapter IDs and cached chapter numbers.
3. Fetch chapter page 1 with the existing provider/BrowserSession-owned
   chapter-list path (`limit=100`, newest first).
4. Add any chapters not already cached.
5. Stop when one of these is true:
   - a fetched chapter ID already exists in cache
   - fetched chapter numbers reach or go below `cachedMax`
   - merged data now covers `observedLatestChapter`
6. If not stopped and page 1 did not prove completeness:
   - fetch page 2, then page 3, etc.
7. Put a conservative page budget on incremental reconcile, for example 3-5
   pages. If the budget is exceeded, queue a full `cache-chapters` refresh.
8. Write the merged chapter list atomically.
9. Enqueue chapter-image jobs only for newly discovered chapters.

For the normal "one new chapter" case, this should be one signed chapter-list
request and one SQLite update.

For a large release gap, the job can fetch a few pages and then fall back to a
full refresh if it cannot prove completeness.

## Merge Rules

The cached chapter-list payload should remain provider-shaped so existing
frontend parsing keeps working.

Merge by stable chapter ID first.

Sort after merge by chapter number descending, with current existing behavior
preserved for tie handling. If multiple groups share a chapter number, do not
dedupe them at the cache layer; group filtering/deduping remains frontend
display policy.

Update pagination metadata so it remains truthful enough for current parser
and logs:

- `current_page = 1`
- `page = 1`
- `total = merged item count` unless upstream provides a stronger total
- preserve upstream pagination fields that still make sense

## Priority and Promotion

Current cache queues have foreground/background behavior. Reconcile needs
stronger semantics:

- `background`: startup discovery and image backlog.
- `observed`: search noticed stale cache.
- `foreground`: user opened the manga or reader needs it now.

Implementation can use multiple arrays or a priority enum, but logs must show
the semantic priority.

Rules:

- If an `observed` reconcile is queued and a `foreground` reconcile arrives
  for the same manga, promote the existing job.
- Do not duplicate jobs for the same manga and kind.
- If a foreground reconcile arrives while a background chapter-list job for the
  same manga is queued, promote that work rather than adding another one.
- If a background job is currently active, it can finish its current atomic
  request/write, then foreground jobs should run next.
- Do not interrupt an in-flight signed request mid-request unless the current
  code already has safe cancellation for it. Priority should be real at job
  boundaries first.

## Frontend Triggers

### Search Results

After live search results arrive:

1. For each result with a valid `latestChapter`, compare against known cached
   filtered/max state if available.
2. If search latest is newer than cached max, report reconcile with:
   - `source = search-result`
   - `priority = observed`
3. Dedupe per manga ID.
4. Debounce/batch so a 100-result page does not send 100 immediate requests in
   one frame.

Open question for implementation:

- We may need a cheap backend cache-summary endpoint so the frontend can know
  cached max without parsing full chapter lists for every search result.
  If the frontend only has memory stats for some cards, search-triggered
  reconcile should be conservative and capped.

### Manga Open

When opening a manga from search/favorites/recommendations:

1. If the card/result has `latestChapter`, send reconcile with:
   - `source = manga-open`
   - `priority = foreground`
2. Then continue opening the manga through the existing cache read path.
3. If the cached list is stale/missing, the cache read should see `warming`
   and poll until the foreground reconcile/cache job finishes.

This gives the user-open path priority over passive search observation without
creating a separate repair model.

## Backend Cache Metadata

Current code can compute cached max by parsing the cached chapter-list row.
That is acceptable for a first implementation.

Better architecture is to persist or expose cache summary metadata:

```ts
{
  mangaId,
  cachedMaxChapter,
  chapterCount,
  updatedAt,
  status
}
```

Options:

1. Derive it on demand from `chapter_list_cache`.
   - Simpler.
   - More CPU if called for many search results.
2. Store metadata columns or a side table.
   - Better for search-page bulk comparison.
   - Requires migration/backfill.

Recommended first step:

- Derive on backend for reconciliation decisions.
- Add summary persistence only if logs show search-result reconcile checks are
  too expensive.

## Logging Requirements

Add logs that let us verify this story:

- frontend search result mismatch detected:
  - manga ID
  - observed latest
  - known cached max, if known
  - source
- backend reconcile decision:
  - manga ID
  - cached max
  - observed latest
  - action: `fresh | queued | promoted | full-refresh | ignored`
  - priority/source/reason
- incremental page fetch:
  - page number
  - items fetched
  - new items
  - whether cached top/max was reached
- merge result:
  - previous count/max
  - new count/max
  - newly queued chapter-image jobs
- promotion:
  - old priority
  - new priority
  - reason

If logs cannot tell whether search noticed stale data, backend queued repair,
and manga open promoted it, the logging is incomplete.

## Failure Behavior

- If incremental reconcile fails with a transient upstream error:
  - keep old cache row
  - log failure
  - leave future search/open triggers able to retry
- If incremental reconcile cannot prove completeness within page budget:
  - queue full `cache-chapters` refresh with foreground priority if user-opened
  - do not delete the old cache until the replacement is ready
- If full refresh fails:
  - keep old cache
  - surface existing cache to the user if available
  - log stale/error state

The UI should not become worse because a repair failed. Old cache is stale but
usable; missing cache is warming/error.

## Non-Goals

- Do not reintroduce generic frontend proxying.
- Do not make the frontend understand Comix chapter-list pagination.
- Do not invalidate/delete a 3000-chapter cache row before a replacement is
  ready.
- Do not make search block on cache repair.
- Do not enqueue image discovery for every existing chapter during a small
  reconcile; only new chapters need image jobs.

## Implementation Order

1. Add backend reconcile endpoint and decision logs.
2. Add cache-service job type and priority/promotion semantics.
3. Implement incremental page fetch and merge.
4. Add frontend observed mismatch reporting from search results, capped and
   deduped.
5. Add foreground reconcile reporting on manga open.
6. Verify with logs:
   - search result detects stale cached max
   - backend queues observed reconcile
   - opening the manga promotes it
   - incremental reconcile fetches only needed pages in normal case
   - old cache remains usable on failure
