# Navigation

Tests assert business rules. If a test fails, the code is wrong — not the test.
The only exception is when a business rule changes.

---

### View Stack

**T-AO-1: Exactly 7 valid view stack configurations**
Tests rule AO.
The view stack only allows these configurations:
- `[list]`
- `[list, repos]`
- `[list, favorites]`
- `[list, manga]`
- `[list, favorites, manga]`
- `[list, manga, reader]`
- `[list, favorites, manga, reader]`

```contract
type: ViewName = 'list' | 'repos' | 'favorites' | 'manga' | 'reader'
type: ViewStack = ViewName[]
constant: VALID_STACKS
assert: value deep-equals [
  ['list'],
  ['list', 'repos'],
  ['list', 'favorites'],
  ['list', 'manga'],
  ['list', 'favorites', 'manga'],
  ['list', 'manga', 'reader'],
  ['list', 'favorites', 'manga', 'reader']
]
function: isValidStack(stack: ViewStack) → boolean
assert: returns true for each of the 7 stacks above
assert: returns false for any other combination
```

**T-AO-2: Back always pops one level**
Tests rule AO.
Back (swipe or button) pops one level from the stack. No skipping, no duplicates.

```contract
function: popViewStack(stack: ViewStack) → ViewStack
input: ['list', 'manga', 'reader']
assert: returns ['list', 'manga']
input: ['list', 'manga']
assert: returns ['list']
input: ['list']
assert: returns ['list'] (cannot pop below root)
```

**T-AO-3: Repos is a leaf**
Tests rule AO.
From repos, you can only go back to list — not deeper.

```contract
function: isValidStack(stack: ViewStack) → boolean
input: ['list', 'repos', 'manga']
assert: returns false — repos allows no deeper pushes
input: ['list', 'repos']
assert: returns true — repos is a valid leaf
```

**T-AO-4: Session restore rebuilds all views below current**
Tests rule AO.
On restore, every view below the current one has correct content so swipe-back reveals the right screen.

### Swipe-Back Gesture

**T-AT-1: Edge zone is left 7.7% of screen width**
Tests rule AT.
The swipe must start within the left 7.7% of the screen.

```contract
constant: EDGE_ZONE_RATIO
assert: value === 0.077
```

**T-AT-2: 1.3% deadzone before lock**
Tests rule AT.
A 1.3% deadzone must be crossed before the gesture locks. If vertical movement exceeds horizontal before the deadzone, the gesture is rejected.

```contract
constant: DEADZONE_RATIO
assert: value === 0.013
```

**T-AT-3: 15% drag threshold to trigger back**
Tests rule AT.
After locking, the user must drag at least 15% of the remaining screen width to trigger navigation.

```contract
constant: SWIPE_THRESHOLD_RATIO
assert: value === 0.15
```

**T-AT-4: Animation follows drag and snaps**
Tests rule AT.
The view animates with the drag position and snaps to completion or cancellation on release.
