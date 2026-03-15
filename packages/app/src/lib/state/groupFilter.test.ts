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

const { GroupFilterState } = await import('./groupFilter.svelte.js');

beforeEach(() => {
  store.clear();
});

describe('GroupFilterState: provider-wide group blacklist', () => {
  it('starts empty with no saved data', () => {
    const gf = new GroupFilterState();
    expect(gf.groups).toEqual([]);
    expect(gf.count).toBe(0);
  });

  it('add persists group to storage', () => {
    const gf = new GroupFilterState();
    gf.add('gX', 'Group X');

    expect(gf.isFiltered('gX')).toBe(true);
    expect(gf.count).toBe(1);

    // Persisted
    const saved = JSON.parse(store.get('globalGroupFilter')!);
    expect(saved).toHaveLength(1);
    expect(saved[0].groupId).toBe('gX');
  });

  it('add is idempotent — no duplicates', () => {
    const gf = new GroupFilterState();
    gf.add('gX', 'Group X');
    gf.add('gX', 'Group X');
    expect(gf.count).toBe(1);
  });

  it('remove deletes group and persists', () => {
    const gf = new GroupFilterState();
    gf.add('gX', 'Group X');
    gf.add('gY', 'Group Y');
    expect(gf.count).toBe(2);

    gf.remove('gX');
    expect(gf.isFiltered('gX')).toBe(false);
    expect(gf.isFiltered('gY')).toBe(true);
    expect(gf.count).toBe(1);
  });

  it('clear removes all groups', () => {
    const gf = new GroupFilterState();
    gf.add('gX', 'Group X');
    gf.add('gY', 'Group Y');

    gf.clear();
    expect(gf.count).toBe(0);
    expect(gf.groups).toEqual([]);
  });

  it('restores from storage on construction', () => {
    store.set('globalGroupFilter', JSON.stringify([
      { groupId: 'gA', groupName: 'A' },
      { groupId: 'gB', groupName: 'B' },
    ]));

    const gf = new GroupFilterState();
    expect(gf.count).toBe(2);
    expect(gf.isFiltered('gA')).toBe(true);
    expect(gf.isFiltered('gB')).toBe(true);
  });
});
