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

const { saveSession, loadSession, clearSession } = await import('./session.js');

beforeEach(() => {
  store.clear();
});

describe('T-AP-1: Session snapshot save/load', () => {
  it('saveSession persists to storage', () => {
    const snapshot = {
      viewMode: 'manga' as const,
      viewStack: ['list' as const],
      activeManga: { id: 'one-piece', title: 'One Piece', cover: 'op.jpg', latestChapter: 1100 },
      searchContext: { query: 'naruto', filters: undefined },
    };

    saveSession(snapshot);

    const loaded = loadSession();
    expect(loaded).not.toBeNull();
    expect(loaded!.viewMode).toBe('manga');
    expect(loaded!.viewStack).toEqual(['list']);
    expect(loaded!.activeManga!.id).toBe('one-piece');
    expect(loaded!.searchContext!.query).toBe('naruto');
  });

  it('loadSession returns null when no snapshot exists', () => {
    expect(loadSession()).toBeNull();
  });

  it('clearSession removes snapshot', () => {
    saveSession({
      viewMode: 'list' as const,
      viewStack: [],
    });
    expect(loadSession()).not.toBeNull();

    clearSession();
    expect(loadSession()).toBeNull();
  });
});

describe('Session snapshot round-trips all fields', () => {
  it('targetMangaId survives round-trip', () => {
    saveSession({
      viewMode: 'list' as const,
      viewStack: [],
      targetMangaId: 'abc123',
    });

    const loaded = loadSession();
    expect(loaded!.targetMangaId).toBe('abc123');
  });

  it('undefined optional fields are not lost', () => {
    saveSession({
      viewMode: 'list' as const,
      viewStack: [],
    });

    const loaded = loadSession();
    expect(loaded!.activeManga).toBeUndefined();
    expect(loaded!.searchContext).toBeUndefined();
    expect(loaded!.targetMangaId).toBeUndefined();
  });
});
