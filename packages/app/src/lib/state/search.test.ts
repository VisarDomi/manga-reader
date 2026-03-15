import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError, ApiErrKind } from '../services/fetchJson.js';
import type { Manga } from '../types.js';

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

// Api fake — queued pending calls for resolve/reject control
interface PendingCall {
  resolve: (value: { manga: Manga[]; hasMore: boolean }) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
}
const pendingCalls: PendingCall[] = [];

vi.mock('../services/api.js', () => ({
  searchManga: (_query: string, _page: number, _filters: unknown, signal?: AbortSignal) => {
    return new Promise<{ manga: Manga[]; hasMore: boolean }>((resolve, reject) => {
      pendingCalls.push({ resolve, reject, signal });
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

describe('T-BD-1: First search failure shows persistent error', () => {
  it('network error → error.kind === network', async () => {
    const toast = new ToastState();
    const search = new SearchState(toast);

    const p = search.search('naruto');
    lastPending().reject(new ApiError(ApiErrKind.NETWORK));
    await p;

    expect(search.error).not.toBeNull();
    expect(search.error!.kind).toBe('network');
    expect(search.results).toEqual([]);
    expect(search.hasMore).toBe(false);
    expect(search.isLoading).toBe(false);
  });

  it('timeout error → error.kind === timeout', async () => {
    const toast = new ToastState();
    const search = new SearchState(toast);

    const p = search.search('naruto');
    lastPending().reject(new ApiError(ApiErrKind.TIMEOUT));
    await p;

    expect(search.error).not.toBeNull();
    expect(search.error!.kind).toBe('timeout');
  });

  it('HTTP 500 → error.kind === upstream', async () => {
    const toast = new ToastState();
    const search = new SearchState(toast);

    const p = search.search('naruto');
    lastPending().reject(new ApiError(ApiErrKind.HTTP, 500));
    await p;

    expect(search.error).not.toBeNull();
    expect(search.error!.kind).toBe('upstream');
  });

  it('successful retry clears error state', async () => {
    const toast = new ToastState();
    const search = new SearchState(toast);

    // First search fails
    let p = search.search('naruto');
    lastPending().reject(new ApiError(ApiErrKind.NETWORK));
    await p;
    expect(search.error).not.toBeNull();

    // Retry succeeds
    p = search.search('naruto');
    lastPending().resolve({ manga: [], hasMore: false });
    await p;

    expect(search.error).toBeNull();
  });
});
