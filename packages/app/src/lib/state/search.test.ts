import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ErrorKind } from '../logic.js';
import { Msg } from '../messages.js';
import { createStorageFake } from '../test-helpers/storage-fake.js';
import type { Manga } from '../types.js';

const { store, fake: storageFake } = createStorageFake();

vi.mock('../services/storage.js', () => storageFake);

// Api fake — queued pending calls for resolve/reject control
interface PendingCall {
  resolve: (value: { manga: Manga[]; hasMore: boolean }) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
}
const pendingCalls: PendingCall[] = [];

vi.mock('../services/api.js', () => ({
  searchManga: (_query: string, _page: number, _filters: unknown, signal?: AbortSignal) => {
    return new Promise<{ manga: Manga[]; hasMore: boolean }>((resolve, reject) => {
      pendingCalls.push({ resolve, reject, signal });
    });
  },
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

describe('T-BD-1: First search failure shows persistent error', () => {
  it('network error → error.kind === network', async () => {
    const toast = new ToastState();
    const search = new SearchState(toast);

    const p = search.search('naruto');
    lastPending().reject({ kind: ErrorKind.NETWORK });
    await p;

    expect(search.error).not.toBeNull();
    expect(search.error!.kind).toBe(ErrorKind.NETWORK);
    expect(search.results).toEqual([]);
    expect(search.hasMore).toBe(false);
    expect(search.isLoading).toBe(false);
  });

  it('timeout error → error.kind === timeout', async () => {
    const toast = new ToastState();
    const search = new SearchState(toast);

    const p = search.search('naruto');
    lastPending().reject({ kind: ErrorKind.TIMEOUT });
    await p;

    expect(search.error).not.toBeNull();
    expect(search.error!.kind).toBe(ErrorKind.TIMEOUT);
  });

  it('HTTP 500 → error.kind === upstream', async () => {
    const toast = new ToastState();
    const search = new SearchState(toast);

    const p = search.search('naruto');
    lastPending().reject({ kind: ErrorKind.UPSTREAM, status: 500 });
    await p;

    expect(search.error).not.toBeNull();
    expect(search.error!.kind).toBe(ErrorKind.UPSTREAM);
  });

  it('successful retry clears error state', async () => {
    const toast = new ToastState();
    const search = new SearchState(toast);

    // First search fails
    let p = search.search('naruto');
    lastPending().reject({ kind: ErrorKind.NETWORK });
    await p;
    expect(search.error).not.toBeNull();

    // Retry succeeds
    p = search.search('naruto');
    lastPending().resolve({ manga: [], hasMore: false });
    await p;

    expect(search.error).toBeNull();
  });
});

describe('T-BB-2: Pagination failure shows toast', () => {
  // Helper: set up a SearchState with initial results + hasMore=true
  async function searchWithResults(toast: InstanceType<typeof ToastState>) {
    const search = new SearchState(toast);
    const p = search.search('test');
    lastPending().resolve({
      manga: [{ id: 'a', title: 'A', cover: 'a.jpg', latestChapter: 1 }],
      hasMore: true,
    });
    await p;
    return search;
  }

  it('transient timeout → page rolls back, hasMore stays true, toast SLOW_CONNECTION', async () => {
    const toast = new ToastState();
    const search = await searchWithResults(toast);

    const p = search.loadNextPage();
    lastPending().reject({ kind: ErrorKind.TIMEOUT });
    await p;

    expect(search.currentPage).toBe(1);
    expect(search.hasMore).toBe(true);
    expect(search.error).toBeNull();
    expect(toast.items.some(t => t.message === Msg.SLOW_CONNECTION)).toBe(true);
  });

  it('permanent 404 → hasMore false, toast LOAD_MORE_FAILED', async () => {
    const toast = new ToastState();
    const search = await searchWithResults(toast);

    const p = search.loadNextPage();
    lastPending().reject({ kind: ErrorKind.UPSTREAM, status: 404 });
    await p;

    expect(search.hasMore).toBe(false);
    expect(search.error).toBeNull();
    expect(toast.items.some(t => t.message === Msg.LOAD_MORE_FAILED)).toBe(true);
  });

  it('transient HTTP 429 → page rolls back, hasMore stays true', async () => {
    const toast = new ToastState();
    const search = await searchWithResults(toast);

    const p = search.loadNextPage();
    lastPending().reject({ kind: ErrorKind.UPSTREAM, status: 429 });
    await p;

    expect(search.currentPage).toBe(1);
    expect(search.hasMore).toBe(true);
    expect(toast.items.some(t => t.message === Msg.SLOW_CONNECTION)).toBe(true);
  });
});

describe('T-AC-4: Enter skips debounce', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('search() fires immediately, pending debounce does not fire duplicate', () => {
    const toast = new ToastState();
    const search = new SearchState(toast);

    // t=0: toggle filter — starts 500ms debounce
    search.filters.toggleTerm('1');
    expect(pendingCalls).toHaveLength(0);

    // t=100: "enter" — search fires immediately
    vi.advanceTimersByTime(100);
    search.search('query');
    expect(pendingCalls).toHaveLength(1);

    const callCountAfterEnter = pendingCalls.length;

    // t=500: debounce from toggleTerm would fire — should NOT create a duplicate search
    vi.advanceTimersByTime(400);
    expect(pendingCalls).toHaveLength(callCountAfterEnter);
  });
});
