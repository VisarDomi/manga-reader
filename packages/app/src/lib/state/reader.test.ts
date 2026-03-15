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
  ApiError: class ApiError extends Error {
    constructor(public kind: string, public status?: number) { super(kind); }
  },
  ApiErrKind: {
    NETWORK: 'network', TIMEOUT: 'timeout', HTTP: 'http',
    PARSE: 'parse', CLOUDFLARE: 'cloudflare',
  },
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
const chapter: ChapterMeta = { id: 'ch-100', number: 100, groupName: 'GroupA' };

beforeEach(() => {
  store.clear();
  progressStore.clear();
  lastProgressKey = null;
  lastProgressData = null;
});

describe('T-AH-1: Progress keyed by repoUrl:providerId:mangaId', () => {
  // Known-failing: blocked on BH (repo/provider scoping not implemented)
  it.fails('db.setProgress receives composite key, not bare manga.id', async () => {
    const ui = new UIState();
    const toast = new ToastState();
    const gf = new GroupFilterState();
    const mangaState = new MangaState(ui, toast, gf);
    // Set activeManga and chapters so filteredChapters works
    mangaState.activeManga = manga;
    mangaState.chapters = [chapter];
    const progress = new ProgressState();
    const reader = new ReaderState(ui, mangaState, progress, toast);

    await reader.openReader(manga, chapter);

    // Spec says key must be repoUrl:providerId:mangaId
    // Currently code passes manga.id ('one-piece') — this SHOULD fail
    expect(lastProgressKey).not.toBe('one-piece');
    expect(lastProgressKey).toContain('one-piece');
    expect(lastProgressKey).toMatch(/^.+:.+:one-piece$/);
  });
});
