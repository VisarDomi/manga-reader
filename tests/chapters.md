# Chapter Groups & Progressive Loading

Tests assert business rules. If a test fails, the code is wrong — not the test.
The only exception is when a business rule changes.

---

### Chapter Groups

**T-AF-1: Provider-wide group blacklist hides chapters**
Tests rule AF.
Given group X is in the provider-wide blacklist,
then chapters from group X are hidden across all manga for that provider.

```contract
pipeline: filteredChapters(
  chapters: ChapterMeta[],
  blacklistedGroupIds: Set<string>,
  selectedGroupIds: Set<string> | null
) → ChapterMeta[]
input:
  chapters: [
    { id: '1', number: 1, groupId: 'gA', groupName: 'A' },
    { id: '2', number: 2, groupId: 'gX', groupName: 'X' }
  ]
  blacklistedGroupIds: Set(['gX'])
  selectedGroupIds: null
assert: returns [id '1'] — group X is blacklisted, sorted descending
```

**T-AF-2: Per-manga group selector overrides blacklist**
Tests rule AF.
Given group X is blacklisted provider-wide but selected in the per-manga selector,
then group X's chapters are visible for that manga only.

```contract
pipeline: filteredChapters(
  chapters: ChapterMeta[],
  blacklistedGroupIds: Set<string>,
  selectedGroupIds: Set<string> | null
) → ChapterMeta[]
input:
  chapters: [
    { id: '1', number: 1, groupId: 'gA', groupName: 'A' },
    { id: '2', number: 2, groupId: 'gX', groupName: 'X' }
  ]
  blacklistedGroupIds: Set(['gX'])
  selectedGroupIds: Set(['gX'])
assert: returns [id '2'] — per-manga selection overrides blacklist, only selected group shown, sorted descending
```

**T-AF-3: Blacklisted groups appear grayed out but selectable**
Tests rule AF.
In the per-manga group selector, provider-wide blacklisted groups are visually grayed out but can still be selected.

**T-AF-4: Same chapter number from multiple groups — latest upload wins**
Tests rule AF.
Given group A uploaded chapter 5 on Jan 1 and group B uploaded chapter 5 on Jan 2, and both groups are selected,
then only group B's chapter 5 is shown.

```contract
pipeline: filteredChapters(
  chapters: ChapterMeta[],
  blacklistedGroupIds: Set<string>,
  selectedGroupIds: Set<string> | null
) → ChapterMeta[]
input:
  chapters: [
    { id: '1', number: 5, groupId: 'gA', groupName: 'A', uploadedAt: 1704067200 },
    { id: '2', number: 5, groupId: 'gB', groupName: 'B', uploadedAt: 1704153600 }
  ]
  blacklistedGroupIds: Set([])
  selectedGroupIds: Set(['gA', 'gB'])
assert: returns [id '2'] — same number 5, group B uploaded later wins
```

**T-AF-5: Chapters sorted descending by number**
Tests rule AF.
Chapters are displayed newest first (descending by chapter number).

```contract
pipeline: filteredChapters(
  chapters: ChapterMeta[],
  blacklistedGroupIds: Set<string>,
  selectedGroupIds: Set<string> | null
) → ChapterMeta[]
input:
  chapters: [
    { id: '1', number: 1, groupId: 'gA', groupName: 'A' },
    { id: '3', number: 3, groupId: 'gA', groupName: 'A' },
    { id: '2', number: 2, groupId: 'gA', groupName: 'A' }
  ]
  blacklistedGroupIds: Set([])
  selectedGroupIds: null
assert: returns chapters in order [3, 2, 1] by number
```

**T-AF-6: Long-press on group item shows block/cancel**
Tests rule AB + AF.
Long-pressing a group item in the chapter list shows a block/cancel option to add the group to the provider-wide blacklist.

### Progressive Chapter Loading

**T-AG-1: Chapters yielded progressively in descending order**
Tests rule AG.
When opening a manga, the app renders chapters as each page arrives without waiting for the full list. Page 1 (newest chapters) fills the top of the list.

**T-AG-2: Deduplication on each batch**
Tests rule AG.
On each incoming batch, the app deduplicates by chapter ID and re-applies group filtering and sorting.

```contract
function: mergeChapterPages(pages: (ChapterMeta[] | null)[]) → ChapterMeta[]
setup: pages with overlapping chapter IDs
  page 1: [{ id: 'ch-1' }, { id: 'ch-2' }]
  page 2: [{ id: 'ch-2' }, { id: 'ch-3' }]
  page 3: null (failed)
assert: returns 3 chapters with unique IDs [ch-1, ch-2, ch-3]
assert: first occurrence wins (page 1's ch-2, not page 2's)
```

**T-AG-3: Partial data shown on partial failure**
Tests rule AG.
If some chapter list pages fail but others succeed, the app shows what it got.

```contract
function: mergeChapterPages(pages: (ChapterMeta[] | null)[]) → ChapterMeta[]
case 1 (partial success):
  setup: page 1 has chapters, pages 2-5 are null (failed)
  assert: returns page 1's chapters (not empty)
case 2 (all failed):
  setup: all pages are null
  assert: returns empty array
```
