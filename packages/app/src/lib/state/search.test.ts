import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError, ApiErrKind } from '../services/fetchJson.js';
import type { Manga } from '../types.js';
import { Msg } from '../messages.js';

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

// Api fake — queued responses
interface PendingCall {
  resolve: (value: { manga: Manga[]; hasMore: boolean }) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  query: string;
  page: number;
}
const pendingCalls: PendingCall[] = [];

vi.mock('../services/api.js', () => ({
  searchManga: (query: string, page: number, _filters: unknown, signal?: AbortSignal) => {
    return new Promise<{ manga: Manga[]; hasMore: boolean }>((resolve, reject) => {
      pendingCalls.push({ resolve, reject, signal, query, page });
    });
  },
  ApiError,
  ApiErrKind,
}));

const { SearchState } = await import('./search.svelte.js');
const { ToastState } = await import('./toast.svelte.js');

function lastPending(): PendingCall {
  return pendingCalls[pendingCalls.length - 1];
}

beforeEach(() => {
  store.clear();
  pendingCalls.length = 0;
});

describe('T-AC-3: Changes abort in-flight requests', () => {
  it('starting a new search aborts the previous signal', async () => {
    const toast = new ToastState();
    const search = new SearchState(toast);

    search.search('naruto');
    const firstSignal = lastPending().signal!;
    expect(firstSignal.aborted).toBe(false);

    search.search('one piece');
    expect(firstSignal.aborted).toBe(true);
  });
});

describe('T-AC-5: Search is non-blocking', () => {
  it('UI state accessible while search is in-flight', () => {
    const toast = new ToastState();
    const search = new SearchState(toast);

    search.search('naruto');

    expect(search.isLoading).toBe(true);
    expect(search.filters).toBeDefined();
    expect(search.filters.termStates).toBeDefined();
  });

  it('new search can be initiated while previous is pending', () => {
    const toast = new ToastState();
    const search = new SearchState(toast);

    search.search('naruto');
    const firstSignal = lastPending().signal!;

    search.search('one piece');

    expect(firstSignal.aborted).toBe(true);
    expect(search.isLoading).toBe(true);
  });
});

describe('T-BD-1: First search failure shows persistent error', () => {
  it('network error sets error state on SearchState', async () => {
    const toast = new ToastState();
    const search = new SearchState(toast);

    const p = search.search('naruto');
    lastPending().reject(new ApiError(ApiErrKind.NETWORK));
    await p;

    expect(search.error).not.toBeNull();
    expect(search.error!.kind).toBe('network');
    expect(search.results).toEqual([]);
    expect(search.hasMore).toBe(false);
  });

  it('timeout error sets error state', async () => {
    const toast = new ToastState();
    const search = new SearchState(toast);

    const p = search.search('naruto');
    lastPending().reject(new ApiError(ApiErrKind.TIMEOUT));
    await p;

    expect(search.error).not.toBeNull();
    expect(search.error!.kind).toBe('timeout');
  });

  it('HTTP error sets error state with status', async () => {
    const toast = new ToastState();
    const search = new SearchState(toast);

    const p = search.search('naruto');
    lastPending().reject(new ApiError(ApiErrKind.HTTP, 500));
    await p;

    expect(search.error).not.toBeNull();
    expect(search.error!.kind).toBe('upstream');
  });
});

describe('T-BB-1: Initial failure shows persistent error state', () => {
  it('error persists until user retries — not a transient toast', async () => {
    const toast = new ToastState();
    const search = new SearchState(toast);

    const p = search.search('naruto');
    lastPending().reject(new ApiError(ApiErrKind.NETWORK));
    await p;

    expect(search.error).not.toBeNull();
    expect(search.results).toEqual([]);
    expect(search.isLoading).toBe(false);
  });

  it('successful retry clears error state', async () => {
    const toast = new ToastState();
    const search = new SearchState(toast);

    let p = search.search('naruto');
    lastPending().reject(new ApiError(ApiErrKind.NETWORK));
    await p;
    expect(search.error).not.toBeNull();

    p = search.search('naruto');
    lastPending().resolve({ manga: [], hasMore: false });
    await p;

    expect(search.error).toBeNull();
  });
});

describe('T-AD: Pagination deduplicates and respects hasMore', () => {
  it('loadNextPage appends deduplicated results', async () => {
    const toast = new ToastState();
    const search = new SearchState(toast);

    // Initial search
    const manga1: Manga[] = [
      { id: 'a', title: 'A', cover: 'a.jpg', latestChapter: 1 },
      { id: 'b', title: 'B', cover: 'b.jpg', latestChapter: 2 },
    ];
    let p = search.search('test');
    lastPending().resolve({ manga: manga1, hasMore: true });
    await p;
    expect(search.results).toHaveLength(2);

    // Page 2 with a duplicate
    const manga2: Manga[] = [
      { id: 'b', title: 'B', cover: 'b.jpg', latestChapter: 2 },
      { id: 'c', title: 'C', cover: 'c.jpg', latestChapter: 3 },
    ];
    p = search.loadNextPage();
    lastPending().resolve({ manga: manga2, hasMore: false });
    await p;

    // Deduplicated: a, b, c (no duplicate b)
    expect(search.results).toHaveLength(3);
    expect(search.results.map(m => m.id)).toEqual(['a', 'b', 'c']);
    expect(search.hasMore).toBe(false);
  });

  it('loadNextPage does nothing when hasMore is false', async () => {
    const toast = new ToastState();
    const search = new SearchState(toast);

    let p = search.search('test');
    lastPending().resolve({ manga: [], hasMore: false });
    await p;

    await search.loadNextPage();
    // No new pending call — loadNextPage exited early
    expect(pendingCalls).toHaveLength(1);
  });

  it('loadNextPage does nothing while already loading', async () => {
    const toast = new ToastState();
    const search = new SearchState(toast);

    let p = search.search('test');
    lastPending().resolve({ manga: [{ id: 'a', title: 'A', cover: 'a.jpg', latestChapter: 1 }], hasMore: true });
    await p;

    // Start first loadNextPage (don't resolve)
    search.loadNextPage();
    const callCount = pendingCalls.length;

    // Second loadNextPage should be ignored
    search.loadNextPage();
    expect(pendingCalls).toHaveLength(callCount);
  });
});

describe('SearchState paginateToTarget', () => {
  it('finds target in initial results', async () => {
    const toast = new ToastState();
    const search = new SearchState(toast);

    const p = search.search('test');
    lastPending().resolve({
      manga: [{ id: 'target', title: 'T', cover: 't.jpg', latestChapter: 1 }],
      hasMore: true,
    });
    await p;

    const found = await search.paginateToTarget('target');
    expect(found).toBe(true);
  });

  it('paginates through pages to find target', async () => {
    const toast = new ToastState();
    const search = new SearchState(toast);

    let p = search.search('test');
    lastPending().resolve({
      manga: [{ id: 'a', title: 'A', cover: 'a.jpg', latestChapter: 1 }],
      hasMore: true,
    });
    await p;

    // Start paginating to target
    const paginatePromise = search.paginateToTarget('target');
    // Page 2 doesn't have it
    lastPending().resolve({
      manga: [{ id: 'b', title: 'B', cover: 'b.jpg', latestChapter: 2 }],
      hasMore: true,
    });
    // Need to give the microtask a chance to fire
    await new Promise(r => setTimeout(r, 0));
    // Page 3 has it
    lastPending().resolve({
      manga: [{ id: 'target', title: 'T', cover: 't.jpg', latestChapter: 3 }],
      hasMore: false,
    });

    const found = await paginatePromise;
    expect(found).toBe(true);
    expect(search.results.map(m => m.id)).toContain('target');
  });
});

describe('T-BB-2: Pagination failure shows toast', () => {
  it('transient pagination error shows slow connection toast', async () => {
    const toast = new ToastState();
    const search = new SearchState(toast);

    // Initial search succeeds with hasMore
    const manga: Manga[] = [{ id: 'a', title: 'A', cover: 'a.jpg', latestChapter: 1 }];
    let p = search.search('test');
    lastPending().resolve({ manga, hasMore: true });
    await p;

    expect(search.results).toHaveLength(1);
    expect(search.hasMore).toBe(true);

    // Pagination fails with transient error
    p = search.loadNextPage();
    lastPending().reject(new ApiError(ApiErrKind.TIMEOUT));
    await p;

    // Page counter rolled back, hasMore still true
    expect(search.currentPage).toBe(1);
    expect(search.hasMore).toBe(true);
    expect(toast.items.some(t => t.message === Msg.SLOW_CONNECTION)).toBe(true);
  });

  it('permanent pagination error stops pagination', async () => {
    const toast = new ToastState();
    const search = new SearchState(toast);

    const manga: Manga[] = [{ id: 'a', title: 'A', cover: 'a.jpg', latestChapter: 1 }];
    let p = search.search('test');
    lastPending().resolve({ manga, hasMore: true });
    await p;

    // Pagination fails with permanent error (404)
    p = search.loadNextPage();
    lastPending().reject(new ApiError(ApiErrKind.HTTP, 404));
    await p;

    // hasMore set to false — pagination stops
    expect(search.hasMore).toBe(false);
    expect(toast.items.some(t => t.message === Msg.LOAD_MORE_FAILED)).toBe(true);
  });

  it('transient HTTP error (429) allows retry', async () => {
    const toast = new ToastState();
    const search = new SearchState(toast);

    const manga: Manga[] = [{ id: 'a', title: 'A', cover: 'a.jpg', latestChapter: 1 }];
    let p = search.search('test');
    lastPending().resolve({ manga, hasMore: true });
    await p;

    // Pagination fails with transient HTTP error
    p = search.loadNextPage();
    lastPending().reject(new ApiError(ApiErrKind.HTTP, 429));
    await p;

    // Page counter rolled back, can retry
    expect(search.currentPage).toBe(1);
    expect(search.hasMore).toBe(true);
    expect(toast.items.some(t => t.message === Msg.SLOW_CONNECTION)).toBe(true);
  });
});
