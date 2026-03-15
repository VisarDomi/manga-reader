import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

    expect(fs.termStates.has('87264')).toBe(false);
    expect(fs.termStates.has('87265')).toBe(false);
    expect(fs.termStates.get('100')).toBe(Filter.INCLUDE);
  });
});

describe('T-AC-6: Filters and query persist per provider', () => {
  it('toggled filters survive a FilterState rebuild', () => {
    const onChange = vi.fn();
    const fs1 = new FilterState(onChange);
    fs1.toggleTerm('42');
    fs1.toggleType('manga');

    // Simulate reload — new instance reads from same storage
    const fs2 = new FilterState(onChange);
    expect(fs2.termStates.get('42')).toBe(Filter.INCLUDE);
    expect(fs2.selectedTypes.has('manga')).toBe(true);
  });

});

describe('T-AC-2: Each change restarts the debounce', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('second toggle at t=300 restarts debounce — onChange fires at t=800, not t=500', () => {
    const onChange = vi.fn();
    const fs = new FilterState(onChange);

    // t=0: first toggle
    fs.toggleTerm('1');
    expect(onChange).not.toHaveBeenCalled();

    // t=300: second toggle restarts the debounce
    vi.advanceTimersByTime(300);
    fs.toggleTerm('2');
    expect(onChange).not.toHaveBeenCalled();

    // t=500: first debounce would have fired — but it was restarted
    vi.advanceTimersByTime(200);
    expect(onChange).not.toHaveBeenCalled();

    // t=800: 500ms after last change — debounce fires
    vi.advanceTimersByTime(300);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
