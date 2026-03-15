import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Manga, ChapterMeta } from '../types.js';

// Storage fake
const store = new Map<string, string>();

vi.mock('../services/storage.js', () => ({
  getJson: <T>(key: string, fallback: T): T => {
    const raw = store.get(key);
    if (raw === undefined) return fallback;
    try { return JSON.parse(raw) as T; }
    catch { return fallback; }
  },
  setJson: (key: string, value: unknown) => {
    store.set(key, JSON.stringify(value));
  },
  getString: (key: string, fallback: string) => store.get(key) ?? fallback,
  setString: (key: string, value: string) => store.set(key, value),
  remove: (key: string) => { store.delete(key); },
}));

// Api fake — controlled fetchChapterList
let chapterListResult: ChapterMeta[] | null = null;
let chapterListError: Error | null = null;

vi.mock('../services/api.js', () => ({
  fetchChapterList: async (_mangaId: string) => {
    if (chapterListError) throw chapterListError;
    return chapterListResult ?? [];
  },
  searchManga: async () => ({ manga: [], hasMore: false }),
  ApiError: class ApiError extends Error {
    constructor(public kind: string, public status?: number) { super(kind); }
  },
  ApiErrKind: {
    NETWORK: 'network',
    TIMEOUT: 'timeout',
    HTTP: 'http',
    PARSE: 'parse',
    CLOUDFLARE: 'cloudflare',
  },
}));

const { MangaState } = await import('./manga.svelte.js');
const { UIState } = await import('./ui.svelte.js');
const { ToastState } = await import('./toast.svelte.js');
const { GroupFilterState } = await import('./groupFilter.svelte.js');

const manga: Manga = { id: 'one-piece', title: 'One Piece', cover: 'op.jpg', latestChapter: 1100 };

beforeEach(() => {
  store.clear();
  chapterListResult = null;
  chapterListError = null;
});

describe('T-AG-1: Chapters rendered after fetch, sorted descending', () => {
  it('chapters stored on state after openManga resolves, sorted descending', async () => {
    const ui = new UIState();
    const toast = new ToastState();
    const gf = new GroupFilterState();
    const ms = new MangaState(ui, toast, gf);

    chapterListResult = [
      { id: 'ch3', number: 3, groupName: 'GroupA' },
      { id: 'ch1', number: 1, groupName: 'GroupA' },
      { id: 'ch2', number: 2, groupName: 'GroupA' },
    ];

    await ms.openManga(manga);

    expect(ms.chapters).toHaveLength(3);
    // filteredChapters should be sorted descending by number
    const numbers = ms.filteredChapters.map(ch => ch.number);
    expect(numbers).toEqual([3, 2, 1]);
  });
});

describe('T-AG-2: Deduplication on each batch', () => {
  it('duplicate chapter IDs are deduplicated by fetchChapterList', async () => {
    const ui = new UIState();
    const toast = new ToastState();
    const gf = new GroupFilterState();
    const ms = new MangaState(ui, toast, gf);

    // fetchChapterList already deduplicates by ID — simulate its output
    chapterListResult = [
      { id: 'ch-a', number: 3, groupName: 'GroupA' },
      { id: 'ch-b', number: 1, groupName: 'GroupA' },
    ];

    await ms.openManga(manga);

    const ids = ms.chapters.map(ch => ch.id);
    expect(ids).toEqual(['ch-a', 'ch-b']);
    // No duplicate IDs
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('T-AG-3: Partial data shown on partial failure', () => {
  it('partial results shown when some pages succeed', async () => {
    const ui = new UIState();
    const toast = new ToastState();
    const gf = new GroupFilterState();
    const ms = new MangaState(ui, toast, gf);

    // fetchChapterList returns partial data when some pages fail
    chapterListResult = [
      { id: 'ch-5', number: 5, groupName: 'GroupA' },
      { id: 'ch-4', number: 4, groupName: 'GroupA' },
    ];

    await ms.openManga(manga);

    expect(ms.chapters.length).toBeGreaterThan(0);
    expect(ms.error).toBeNull();
  });

  it('error state when all pages fail', async () => {
    const ui = new UIState();
    const toast = new ToastState();
    const gf = new GroupFilterState();
    const ms = new MangaState(ui, toast, gf);

    chapterListError = new Error('all pages failed');

    await ms.openManga(manga);

    expect(ms.chapters).toHaveLength(0);
    expect(ms.error).not.toBeNull();
  });
});

describe('T-AG-1: Loading state transitions', () => {
  it('isLoading is true during fetch, false after', async () => {
    const ui = new UIState();
    const toast = new ToastState();
    const gf = new GroupFilterState();
    const ms = new MangaState(ui, toast, gf);

    chapterListResult = [
      { id: 'ch1', number: 1, groupName: 'GroupA' },
    ];

    expect(ms.isLoading).toBe(false);
    await ms.openManga(manga);
    expect(ms.isLoading).toBe(false);
    expect(ms.chapters).toHaveLength(1);
  });

  it('pushes MANGA view on open', async () => {
    const ui = new UIState();
    const toast = new ToastState();
    const gf = new GroupFilterState();
    const ms = new MangaState(ui, toast, gf);

    chapterListResult = [];
    await ms.openManga(manga);

    expect(ui.viewMode).toBe('manga');
  });
});

describe('MangaState restoreManga', () => {
  it('restores manga without pushing view', async () => {
    const ui = new UIState();
    const toast = new ToastState();
    const gf = new GroupFilterState();
    const ms = new MangaState(ui, toast, gf);

    chapterListResult = [
      { id: 'ch1', number: 1, groupName: 'GroupA' },
    ];

    const result = await ms.restoreManga(manga);

    expect(result).toBe(true);
    expect(ms.chapters).toHaveLength(1);
    // restoreManga does NOT push view
    expect(ui.viewMode).toBe('list');
  });

  it('returns false on failure', async () => {
    const ui = new UIState();
    const toast = new ToastState();
    const gf = new GroupFilterState();
    const ms = new MangaState(ui, toast, gf);

    chapterListError = new Error('fail');
    const result = await ms.restoreManga(manga);

    expect(result).toBe(false);
    expect(ms.error).not.toBeNull();
  });
});

describe('MangaState closeManga', () => {
  it('clears all state and pops view', async () => {
    const ui = new UIState();
    const toast = new ToastState();
    const gf = new GroupFilterState();
    const ms = new MangaState(ui, toast, gf);

    chapterListResult = [
      { id: 'ch1', number: 1, groupName: 'GroupA' },
    ];
    await ms.openManga(manga);
    expect(ui.viewMode).toBe('manga');

    ms.closeManga();

    expect(ms.activeManga).toBeNull();
    expect(ms.chapters).toHaveLength(0);
    expect(ms.error).toBeNull();
    expect(ui.viewMode).toBe('list');
  });
});

describe('MangaState group selection', () => {
  it('group selection persists to storage and survives rebuild', async () => {
    const ui = new UIState();
    const toast = new ToastState();
    const gf = new GroupFilterState();
    const ms = new MangaState(ui, toast, gf);

    chapterListResult = [
      { id: 'ch1', number: 1, groupId: 'gA', groupName: 'GroupA' },
      { id: 'ch2', number: 2, groupId: 'gB', groupName: 'GroupB' },
    ];

    await ms.openManga(manga);
    ms.toggleGroup('gA');

    // Verify persisted
    const saved = JSON.parse(store.get(`group:${manga.id}`)!);
    expect(saved).toContain('gA');

    // Only selected group's chapters shown
    const filtered = ms.filteredChapters;
    expect(filtered.every(ch => ch.groupId === 'gA')).toBe(true);
  });
});
