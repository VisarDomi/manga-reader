# Filters & Search

Tests assert business rules. If a test fails, the code is wrong — not the test.
The only exception is when a business rule changes.

---

### Filters & Search

**T-AA-1: NSFW genres auto-excluded on first install**
Tests rule AA.
Given a provider whose filter definition includes genres marked as NSFW,
when the provider is used for the first time (no saved filters for that provider),
then every NSFW genre starts in `exclude` state.

```contract
class: FilterState
setup: no saved filters in localStorage (key 'filters' absent)
action: new FilterState(onChange), then seedDefaults(nsfwIds)
assert: every id in nsfwIds has termState 'exclude'
assert: state persisted to localStorage
```

**T-AA-2: NSFW seeding skipped when filters already exist**
Tests rule AA.
Given saved filters already exist for the provider,
when the provider loads,
then no genres are modified — the saved state is used as-is.

```contract
class: FilterState
setup: saved filters exist in localStorage (key 'filters' has terms)
action: new FilterState(onChange), then seedDefaults(nsfwIds)
assert: termStates unchanged — NSFW ids not added
assert: original saved terms preserved
```

**T-AA-3: NSFW seeding is per-provider**
Tests rule AA.
Given provider A has saved filters but provider B does not,
when provider B is activated for the first time,
then provider B's NSFW genres are auto-excluded independently. Provider A's filters are untouched.

_Blocked: FilterState uses a single 'filters' key — per-provider scoping (BH) not yet implemented._

**T-AB-1: Genre filter cycles through 3 states**
Tests rule AB.
Given a genre filter chip,
when tapped repeatedly,
then the state cycles: empty → include → exclude → empty.

```contract
type: FilterState = 'empty' | 'include' | 'exclude'
function: cycleGenreFilter(current: FilterState) → FilterState
case 1: input: 'empty'    → assert: returns 'include'
case 2: input: 'include'  → assert: returns 'exclude'
case 3: input: 'exclude'  → assert: returns 'empty'
```

**T-AB-2: Type and status filters are binary toggles**
Tests rule AB.
Given a type or status filter chip,
when tapped,
then the state toggles: off → on → off.

```contract
function: toggleBinaryFilter(current: boolean) → boolean
case 1: input: false → assert: returns true
case 2: input: true  → assert: returns false
```

**T-AB-3: Long-press not used on filter chips**
Tests rule AB.
Filter chips do not respond to long-press. Long-press is reserved for chapter list group items (rule AF).

**T-AC-1: All search inputs share 500ms debounce**
Tests rule AC.
Given any change (keystroke or filter toggle),
when the user stops changing for 500ms,
then a search fires with the current text + current filters combined from page 1, replacing results entirely.

```contract
constant: SEARCH_DEBOUNCE_MS
assert: value === 500
```

**T-AC-2: Each change restarts the debounce**
Tests rule AC.
Given a keystroke at t=0 and another at t=300ms,
then no search fires at t=500ms. A search fires at t=800ms (500ms after the last change).

```contract
class: FilterState
setup: FilterState with onChange spy, fake timers
action: toggleTerm('1') at t=0, toggleTerm('2') at t=300ms
assert: onChange not called at t=500ms (first debounce would have fired)
assert: onChange called once at t=800ms (500ms after last change)
```

**T-AC-3: Changes abort in-flight requests**
Tests rule AC.
Given a search request is in-flight,
when the user makes any change (keystroke or filter toggle),
then the in-flight request is aborted.

```contract
class: SearchState
setup: search('naruto') started, request in-flight (signal not aborted)
action: search('one piece') called
assert: first search's AbortSignal is aborted
```

**T-AC-4: Enter skips debounce**
Tests rule AC.
Given the user types and immediately presses enter,
then the search fires immediately without waiting 500ms.

```contract
class: SearchState + FilterState
setup: fake timers, filter toggle triggers debounce
action: toggleTerm('1') at t=0, then search('query') at t=100ms
assert: search fires at t=100ms (immediately, not waiting for debounce)
assert: no duplicate search fires at t=500ms (debounce cancelled)
```

**T-AC-5: Search is non-blocking**
Tests rule AC.
While a search is loading,
the UI remains responsive — filters can be toggled, text can be typed.

**T-AC-6: Filters and query persist per provider**
Tests rule AC + BH.
Given the user sets filters and a query,
when the app is reloaded,
then the saved filters and query are restored from persisted storage, scoped by provider key.

```contract
class: FilterState
setup: toggleTerm('42'), toggleType('manga')
action: new FilterState(onChange) — simulating reload
assert: termStates.get('42') === 'include'
assert: selectedTypes.has('manga') === true
```

**T-AD-1: Pagination deduplicates by manga ID**
Tests rule AD.
Given page 1 returns manga [A, B, C] and page 2 returns [C, D, E],
when page 2 appends,
then results are [A, B, C, D, E] — no duplicate C.

```contract
function: deduplicateByMangaId(existing: Manga[], incoming: Manga[]) → Manga[]
input:
  existing: [{ id: 'A', ... }, { id: 'B', ... }, { id: 'C', ... }]
  incoming: [{ id: 'C', ... }, { id: 'D', ... }, { id: 'E', ... }]
assert: returns array with ids ['A', 'B', 'C', 'D', 'E'] — no duplicate C
assert: order preserved (existing first, then new items from incoming)
```

**T-AD-2: Pagination stops when hasMore is false**
Tests rule AD.
Given the provider returns `hasMore: false`,
then no further pages are requested.

```contract
function: shouldLoadNextPage(isLoading: boolean, hasMore: boolean, isRestoring: boolean) → boolean
case 1: input: false, true, false  → assert: returns true
case 2: input: false, false, false → assert: returns false (hasMore is false)
case 3: input: true, true, false   → assert: returns false (already loading)
case 4: input: false, true, true   → assert: returns false (restore in progress)
```

**T-AE-1: Infinite scroll sentinel uses 500% rootMargin**
Tests rule AE.
The IntersectionObserver for the list sentinel has `rootMargin: '500% 0px'`.

```contract
constant: SENTINEL_ROOT_MARGIN
assert: value === '500% 0px'
```

### Manga Cards

**T-AS-1: Manga cards show cover only**
Tests rule AS.
Manga cards render only the cover image — no title text, no author, no badges, no padding between cards.

**T-AS-2: Progress bar shown only for manga with saved progress**
Tests rule AS.
Given manga A has saved progress and manga B does not,
then manga A's card shows a reading progress bar at the bottom. Manga B's card shows no overlay.
