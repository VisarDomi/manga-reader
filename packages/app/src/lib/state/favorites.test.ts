import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Manga } from '../types.js';

// In-memory db fake — same async interface, no IDB
const progressStore = new Map<string, { chapterId: string; chapterNumber: number; pageIndex?: number }>();
const favoritesStore = new Map<string, Manga>();
let dbShouldFail = false;

vi.mock('../services/db.js', () => ({
  getAllFavorites: async () => {
    if (dbShouldFail) throw new Error('IDB read error');
    return [...favoritesStore.values()];
  },
  addFavorite: async (manga: Manga) => {
    if (dbShouldFail) throw new Error('IDB write error');
    favoritesStore.set(manga.id, manga);
  },
  removeFavorite: async (id: string) => {
    if (dbShouldFail) throw new Error('IDB write error');
    favoritesStore.delete(id);
  },
  getAllProgress: async () => {
    if (dbShouldFail) throw new Error('IDB read error');
    const map: Record<string, unknown> = {};
    for (const [k, v] of progressStore) map[k] = v;
    return map;
  },
  getProgress: async (slug: string) => progressStore.get(slug) ?? null,
  setProgress: async (slug: string, data: unknown) => { progressStore.set(slug, data as never); },
}));

const { FavoritesState } = await import('./favorites.svelte.js');
const { ToastState } = await import('./toast.svelte.js');

const manga: Manga = { id: 'one-piece', title: 'One Piece', cover: 'op.jpg', latestChapter: 1100 };

beforeEach(() => {
  favoritesStore.clear();
  progressStore.clear();
  dbShouldFail = false;
});

describe('T-AM-1: Optimistic toggle with revert on failure', () => {
  it('adds favorite optimistically then persists', async () => {
    const toast = new ToastState();
    const favs = new FavoritesState(toast);

    expect(favs.isFavorited('one-piece')).toBe(false);
    await favs.toggle(manga);

    expect(favs.isFavorited('one-piece')).toBe(true);
    expect(favoritesStore.has('one-piece')).toBe(true);
  });

  it('removes favorite optimistically then persists', async () => {
    favoritesStore.set('one-piece', manga);
    const toast = new ToastState();
    const favs = new FavoritesState(toast);
    await favs.init();

    expect(favs.isFavorited('one-piece')).toBe(true);
    await favs.toggle(manga);

    expect(favs.isFavorited('one-piece')).toBe(false);
    expect(favoritesStore.has('one-piece')).toBe(false);
  });

  it('reverts on write failure and shows toast', async () => {
    const toast = new ToastState();
    const favs = new FavoritesState(toast);

    // Toggle with DB failure
    dbShouldFail = true;
    await favs.toggle(manga);

    // Should revert — not favorited
    expect(favs.isFavorited('one-piece')).toBe(false);
    expect(toast.items.some(t => t.message === 'Failed to update favorites')).toBe(true);
  });
});

describe('T-AN-1: Read failures resolve with empty data', () => {
  it('getAllFavorites failure returns empty array', async () => {
    const toast = new ToastState();
    const favs = new FavoritesState(toast);
    dbShouldFail = true;

    await favs.init();

    expect(favs.items).toEqual([]);
  });
});

describe('T-AN-2: Write failures reject for caller handling', () => {
  it('addFavorite failure triggers revert', async () => {
    const toast = new ToastState();
    const favs = new FavoritesState(toast);

    dbShouldFail = true;
    await favs.toggle(manga);

    // Reverted — not in items
    expect(favs.isFavorited('one-piece')).toBe(false);
    expect(toast.items.some(t => t.message === 'Failed to update favorites')).toBe(true);
  });
});
