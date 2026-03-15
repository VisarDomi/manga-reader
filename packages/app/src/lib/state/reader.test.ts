import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStorageFake } from '../test-helpers/storage-fake.js';
import type { Manga, ChapterMeta } from '../types.js';

const { store, fake: storageFake } = createStorageFake();

vi.mock('../services/storage.js', () => storageFake);

// DB fake — capture setProgress key
let lastProgressKey: string | null = null;
let lastProgressData: unknown = null;
const progressStore = new Map<string, unknown>();

vi.mock('../services/db.js', () => ({
  setProgress: async (slug: string, data: unknown) => {
    lastProgressKey = slug;
    lastProgressData = data;
    progressStore.set(slug, data);
  },
  getProgress: async (slug: string) => progressStore.get(slug) ?? null,
  getAllProgress: async () => {
    const map: Record<string, unknown> = {};
    for (const [k, v] of progressStore) map[k] = v;
    return map;
  },
  getAllFavorites: async () => [],
  addFavorite: async () => {},
  removeFavorite: async () => {},
}));

// Api fake
vi.mock('../services/api.js', () => ({
  fetchChapterImages: async () => [
    { url: 'https://cdn.com/page1.jpg', width: 800, height: 1200 },
  ],
  imageProxyUrl: (url: string) => `/proxy?url=${encodeURIComponent(url)}`,
}));

// Provider fake — exposes repoUrl and id for key composition
vi.mock('../services/provider.js', () => ({
  getProvider: () => ({
    id: 'comix',
    baseUrl: 'https://comix.to',
    imageHeaders: () => ({ Referer: 'https://comix.to' }),
  }),
}));

const { ReaderState } = await import('./reader.svelte.js');
const { UIState } = await import('./ui.svelte.js');
const { MangaState } = await import('./manga.svelte.js');
const { ProgressState } = await import('./progress.svelte.js');
const { ToastState } = await import('./toast.svelte.js');
const { GroupFilterState } = await import('./groupFilter.svelte.js');

const manga: Manga = { id: 'one-piece', title: 'One Piece', cover: 'op.jpg', latestChapter: 1100 };
const chapterA: ChapterMeta = { id: 'ch-100', number: 100, groupName: 'GroupA' };
const chapterB: ChapterMeta = { id: 'ch-101', number: 101, groupName: 'GroupA' };

function createReaderState() {
  const ui = new UIState();
  const toast = new ToastState();
  const gf = new GroupFilterState();
  const mangaState = new MangaState(ui, toast, gf);
  mangaState.activeManga = manga;
  mangaState.chapters = [chapterA, chapterB];
  const progress = new ProgressState();
  const reader = new ReaderState(ui, mangaState, progress, toast);
  return { reader, progress, mangaState };
}

beforeEach(() => {
  store.clear();
  progressStore.clear();
  lastProgressKey = null;
  lastProgressData = null;
});

describe('T-AH-1: Progress keyed by repoUrl:providerId:mangaId', () => {
  it('db.setProgress receives composite key, not bare manga.id', async () => {
    const { reader } = createReaderState();

    await reader.openReader(manga, chapterA);

    // Spec says key must be repoUrl:providerId:mangaId
    // Currently code passes manga.id ('one-piece') — this SHOULD fail
    expect(lastProgressKey).not.toBe('one-piece');
    expect(lastProgressKey).toContain('one-piece');
    expect(lastProgressKey).toMatch(/^.+:.+:one-piece$/);
  });
});

describe('T-AH-2: Only one position per manga per provider', () => {
  it('opening chapter B overwrites chapter A progress for same manga', async () => {
    const { reader, progress } = createReaderState();

    await reader.openReader(manga, chapterA);
    expect(lastProgressData).toEqual({ chapterId: 'ch-100', chapterNumber: 100 });

    await reader.openReader(manga, chapterB);
    expect(lastProgressData).toEqual({ chapterId: 'ch-101', chapterNumber: 101 });

    // Only one entry for this manga — last write wins
    // Key must be composite per T-AH-1: repoUrl:providerId:mangaId
    expect(lastProgressKey).toMatch(/^.+:.+:one-piece$/);
    const compositeKey = lastProgressKey!;
    const saved = progress.get(compositeKey);
    expect(saved!.chapterId).toBe('ch-101');
  });
});
