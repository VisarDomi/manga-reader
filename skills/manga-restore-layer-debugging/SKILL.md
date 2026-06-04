---
name: manga-restore-layer-debugging
description: Debug manga-reader app restart, session restore, swipe-back layer stack, search/favorites root replay, comments/reader restore, or missing root results after restore.
---

# Manga Restore Layer Debugging

Use this skill when app restart restores the wrong view, swipe-back reveals an
empty root, favorites/search reload at the wrong time, or comments/reader/manga
layers restore out of order.

## Restore Contract

Restore foreground first, then backing layers, then root data.

Example for restored reader comments:

1. Chapter comments shell is visible/responsive.
2. Reader shell is restored.
3. Manga detail stack is restored in order.
4. Root is restored last: either Search, Favorites, or Providers.
5. Async data for comments/root can populate after shell restore; it must not
   block foreground UI.

## Ownership Rules

- Search and Favorites are exclusive roots.
- Favorites-root restore must not replay Search.
- Search-root restore must not activate Favorites.
- Root replay is a separate restore owner, not hand-written in every
  manga/reader fallback branch.
- Swipe-back should reveal already-owned layers; it should not trigger root
  reloads except when explicitly switching root via Search/Favs/Providers.

## Logs To Read

```bash
journalctl --user -u manga-reader.service --since 'YYYY-MM-DD HH:MM:SS' --until now --no-pager
journalctl --user -u manga-reader.service --since 'YYYY-MM-DD HH:MM:SS' --until now --no-pager \
  | rg "restore-|view-push|view-pop|foreground-work|search-result|favorites|root|reader-open|chapter-comments"
```

Look for:

- `restore-shell`
- `restore-mounted-layers`
- `restore-root`
- `restore-fallback`
- `view-push` / `view-pop`
- `foreground-work`
- search/favorites result counts

If the user says "swiping all the way back shows no results", verify whether
the root shell exists but root data did not replay:

- `view-pop ... to=list` or `to=favorites`
- then `searchResults:0` / `favorites:0`
- no matching `restore-root done`

## Code Areas

```bash
rg -n "restore-root|mountRestoreLayers|hydrateRestored|activateSearchRoot|activateFavoritesRoot|view-push|view-pop|resumeBackgroundWork" packages/app/src/lib
nl -ba packages/app/src/lib/state/index.svelte.ts | sed -n '180,340p'
nl -ba packages/app/src/lib/state/index.svelte.ts | sed -n '430,530p'
nl -ba packages/app/src/lib/state/ui.svelte.ts | sed -n '1,130p'
```

Check the latest saved session shape in IndexedDB indirectly through frontend
logs first. If code inspection is needed, find the session persistence owner:

```bash
rg -n "SessionSnapshot|persistSession|restoreSession|viewStack|searchContext|favorites" packages/app/src/lib
```

Find stale search/favorites coupling:

```bash
rg -n "shouldOwnSearchContext|ownsSearchContext|deferredSearch|bgReplaySearch|activateFavorites|activateSearch|View\\.FAVORITES|View\\.LIST" packages/app/src/lib/state
```

## Good Patterns From History

- Build the visible layer first so restart feels immediate.
- Defer root replay while reader/comments owns the foreground.
- Drain pending root replay when the view becomes safe, usually after swiping
  back to manga detail.
- Keep favorites/search root switching explicit. Switching root destroys the
  other root's ownership; normal swipe-back does not.
- Restore manga-detail scroll stacks independently, including nested
  recommendation manga layers.

## Rejected Patterns

- Restoring Search behind Favorites for historical convenience.
- Hibernating/mounting root views during a swipe in a way that causes rerender
  jank.
- Loading root before foreground reader/comments shell.
- Duplicated `if search then replay else if favorites then activate` branches in
  manga and reader restore paths.
- Waiting on image bytes or comments before restoring the UI shell.

## Verification

Test at least two flows:

1. Restore from reader/comments, swipe back until root, verify root has data.
2. Restore from Favorites-root path, verify Search does not replay.

Then read logs and confirm:

- foreground restore happened first;
- root replay was scheduled/deferred/done exactly once;
- no root reload was triggered by a normal swipe-back.

Useful confirmation command:

```bash
journalctl --user -u manga-reader.service --since 'YYYY-MM-DD HH:MM:SS' --until now --no-pager \
  | rg "restore-shell|restore-mounted-layers|restore-root|view-pop|view-push|search-result|favorites-view|manga-list"
```
