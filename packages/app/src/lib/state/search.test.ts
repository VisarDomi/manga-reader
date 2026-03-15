import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// Api fake — controlled responses at the fetch boundary
let searchResolve: ((value: { manga: never[]; hasMore: boolean }) => void) | null = null;
let lastSignal: AbortSignal | undefined;

vi.mock('../services/api.js', () => ({
  searchManga: (_query: string, _page: number, _filters: unknown, signal?: AbortSignal) => {
    lastSignal = signal;
    return new Promise((resolve) => {
      searchResolve = resolve as never;
    });
  },
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

const { SearchState } = await import('./search.svelte.js');
const { ToastState } = await import('./toast.svelte.js');

beforeEach(() => {
  store.clear();
  searchResolve = null;
  lastSignal = undefined;
});

describe('T-AC-3: Changes abort in-flight requests', () => {
  it('starting a new search aborts the previous signal', async () => {
    const toast = new ToastState();
    const search = new SearchState(toast);

    // Start first search — hangs (never resolved)
    search.search('naruto');
    const firstSignal = lastSignal!;
    expect(firstSignal.aborted).toBe(false);

    // Start second search — should abort the first
    search.search('one piece');
    expect(firstSignal.aborted).toBe(true);
  });
});
