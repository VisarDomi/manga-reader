import { describe, it, expect } from 'vitest';
import { MangaState } from './manga.svelte.js';
import { UIState } from './ui.svelte.js';
import { ToastState } from './toast.svelte.js';
import { GroupFilterState } from './groupFilter.svelte.js';
import { ErrorKind } from '../logic.js';
import { ApiError, ApiErrKind } from '../services/fetchJson.js';
import type { Manga, ChapterMeta } from '../types.js';

// --- Test data ---

const fakeManga: Manga = { id: 'one-piece', title: 'One Piece', cover: '', latestChapter: null };

const fakeChapters: ChapterMeta[] = [
  { id: 'ch-1', number: 1, groupName: 'ScanlationA' },
  { id: 'ch-2', number: 2, groupName: 'ScanlationA' },
];

// --- Fake api ---

function createApiFake() {
  let nextResult: { chapters?: ChapterMeta[]; error?: Error } = {};
  return {
    fetchChapterList: async (_id: string): Promise<ChapterMeta[]> => {
      if (nextResult.error) throw nextResult.error;
      return nextResult.chapters ?? [];
    },
    succeedWith: (chapters: ChapterMeta[]) => { nextResult = { chapters }; },
    failWith: (error: Error) => { nextResult = { error }; },
  };
}

// --- Helpers ---

function createMangaState() {
  const ui = new UIState();
  const toast = new ToastState();
  const gf = new GroupFilterState();
  const api = createApiFake();
  // Pin phase: MangaState doesn't accept api yet — this documents that Rewrite must add it
  const manga = new MangaState(ui, toast, gf, undefined, api);
  return { manga, ui, toast, api };
}

// ── T-BB-1: Initial failure shows persistent error with retry ─────────

describe('T-BB-1: Initial failure shows persistent error with retry', () => {
  it('timeout error → error.kind === timeout, chapters empty, no toast', async () => {
    const { manga, toast, api } = createMangaState();
    api.failWith(new ApiError(ApiErrKind.TIMEOUT));

    await manga.openManga(fakeManga);

    expect(manga.error).not.toBeNull();
    expect(manga.error!.kind).toBe(ErrorKind.TIMEOUT);
    expect(manga.chapters).toEqual([]);
    expect(manga.isLoading).toBe(false);
    expect(toast.items).toEqual([]);
  });

  it('network error → error.kind === network, chapters empty', async () => {
    const { manga, api } = createMangaState();
    api.failWith(new ApiError(ApiErrKind.NETWORK));

    await manga.openManga(fakeManga);

    expect(manga.error).not.toBeNull();
    expect(manga.error!.kind).toBe(ErrorKind.NETWORK);
    expect(manga.chapters).toEqual([]);
    expect(manga.isLoading).toBe(false);
  });

  it('HTTP 500 → error.kind === upstream, chapters empty', async () => {
    const { manga, api } = createMangaState();
    api.failWith(new ApiError(ApiErrKind.HTTP, 500));

    await manga.openManga(fakeManga);

    expect(manga.error).not.toBeNull();
    expect(manga.error!.kind).toBe(ErrorKind.UPSTREAM);
    expect(manga.chapters).toEqual([]);
    expect(manga.isLoading).toBe(false);
  });

  it('retry after failure: success clears error and loads chapters', async () => {
    const { manga, api } = createMangaState();

    // First call fails
    api.failWith(new ApiError(ApiErrKind.TIMEOUT));
    await manga.openManga(fakeManga);
    expect(manga.error).not.toBeNull();

    // Second call succeeds
    api.succeedWith(fakeChapters);
    await manga.openManga(fakeManga);
    expect(manga.error).toBeNull();
    expect(manga.chapters.length).toBeGreaterThan(0);
    expect(manga.isLoading).toBe(false);
  });
});
