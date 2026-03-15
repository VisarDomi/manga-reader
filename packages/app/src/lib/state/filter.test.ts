import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Filter } from '../logic.js';

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

const { FilterState } = await import('./filter.svelte.js');

beforeEach(() => {
  store.clear();
});

describe('T-AA-1: NSFW genres auto-excluded on first install', () => {
  it('seedDefaults sets every NSFW genre ID to exclude', () => {
    const onChange = vi.fn();
    const fs = new FilterState(onChange);
    const nsfwIds = new Set(['87264', '87265', '87266', '87267', '87268']);

    fs.seedDefaults(nsfwIds);

    for (const id of nsfwIds) {
      expect(fs.termStates.get(id)).toBe(Filter.EXCLUDE);
    }
  });

  it('persists the seeded state to storage', () => {
    const onChange = vi.fn();
    const fs = new FilterState(onChange);
    const nsfwIds = new Set(['87264', '87265']);

    fs.seedDefaults(nsfwIds);

    const saved = JSON.parse(store.get('filters')!);
    const savedTermIds = saved.terms.map((t: [string, string]) => t[0]);
    expect(savedTermIds).toContain('87264');
    expect(savedTermIds).toContain('87265');
  });
});

describe('T-AA-2: NSFW seeding skipped when filters already exist', () => {
  it('seedDefaults does not modify existing saved filters', () => {
    // Pre-populate storage with saved filters
    const savedFilters = {
      terms: [['100', 'include']],
      types: [],
      statuses: [],
    };
    store.set('filters', JSON.stringify(savedFilters));

    const onChange = vi.fn();
    const fs = new FilterState(onChange);
    const nsfwIds = new Set(['87264', '87265']);

    fs.seedDefaults(nsfwIds);

    // NSFW IDs should NOT be in termStates — saved state preserved
    expect(fs.termStates.has('87264')).toBe(false);
    expect(fs.termStates.has('87265')).toBe(false);
    // Original saved term should still be there
    expect(fs.termStates.get('100')).toBe(Filter.INCLUDE);
  });
});
