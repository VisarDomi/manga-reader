# Favorites

Tests assert business rules. If a test fails, the code is wrong — not the test.
The only exception is when a business rule changes.

---

### Favorites

**T-AM-1: Optimistic toggle with revert on failure**
Tests rule AM.
Toggling a favorite updates the UI immediately. If the database write fails, the UI reverts and a toast is shown.

```contract
class: FavoritesState
case 1 (add success):
  setup: manga not in favorites, db healthy
  action: toggle(manga)
  assert: isFavorited(manga.id) === true, db contains manga
case 2 (remove success):
  setup: manga in favorites, db healthy
  action: toggle(manga)
  assert: isFavorited(manga.id) === false, db does not contain manga
case 3 (write failure reverts):
  setup: manga not in favorites, db fails on write
  action: toggle(manga)
  assert: isFavorited(manga.id) === false (reverted), toast shown
```

**T-BR-1: Favorites ordered by insertion order**
Tests rule BR.
Favorites appear oldest first, newest at bottom.

```contract
class: FavoritesState
setup: db contains favorites added in order: A, B, C
action: init()
assert: items order is [A, B, C] — oldest first, newest at bottom
```

**T-BR-2: Favorites scroll target is middle-of-viewport card**
Tests rule BR.
For session restore, the scroll target is whichever manga card was at the middle of the viewport when the user left favorites.

### Database Error Handling

**T-AN-1: Read failures resolve with empty data + one-time toast**
Tests rule AN.
Database read failures (progress lookups, favorites listing) resolve with empty data. A one-time toast per session notifies the user.

```contract
class: FavoritesState
setup: db fails on read
action: init()
assert: items === [] (empty, not crash)
```

**T-AN-2: Write failures reject for caller handling**
Tests rule AN.
Database write failures reject. Favorites reverts the optimistic update (AM). Progress shows a toast on first failure per session.

```contract
class: FavoritesState
setup: db fails on write
action: toggle(manga)
assert: optimistic update reverted, toast shown
```

**T-AN-3: DB init failure shows error state without crash**
Tests rule AN.
If database initialization fails, a "Storage unavailable" toast is shown. The app remains usable for browsing and reading without persistence.

```contract
class: FavoritesState
setup: db fails on all operations (getAllFavorites throws)
action: init()
assert: items === [] (empty, not crash)
assert: toast contains "Storage unavailable"
assert: isFavorited() still works (returns false, no throw)
```
