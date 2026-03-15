import { describe, it, expect, vi, beforeEach } from 'vitest';

// Storage fake (needed for GroupFilterState which UIState doesn't use, but modules may import)
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

const { UIState } = await import('./ui.svelte.js');

beforeEach(() => {
  store.clear();
});

describe('T-AO: View stack management', () => {
  it('starts at list view with empty stack', () => {
    const ui = new UIState();
    expect(ui.viewMode).toBe('list');
    expect(ui.viewStack).toEqual([]);
  });

  it('pushView pushes current mode to stack and sets new mode', () => {
    const ui = new UIState();
    ui.pushView('manga');
    expect(ui.viewMode).toBe('manga');
    expect(ui.viewStack).toEqual(['list']);
  });

  it('popView restores previous mode from stack', () => {
    const ui = new UIState();
    ui.pushView('manga');
    ui.popView();
    expect(ui.viewMode).toBe('list');
    expect(ui.viewStack).toEqual([]);
  });

  it('popView does nothing on empty stack', () => {
    const ui = new UIState();
    ui.popView();
    expect(ui.viewMode).toBe('list');
    expect(ui.viewStack).toEqual([]);
  });

  it('multi-level stack: list → manga → reader → pop → pop', () => {
    const ui = new UIState();
    ui.pushView('manga');
    ui.pushView('reader');
    expect(ui.viewMode).toBe('reader');
    expect(ui.viewStack).toEqual(['list', 'manga']);

    ui.popView();
    expect(ui.viewMode).toBe('manga');
    expect(ui.viewStack).toEqual(['list']);

    ui.popView();
    expect(ui.viewMode).toBe('list');
    expect(ui.viewStack).toEqual([]);
  });

  it('canGoBack reflects stack depth', () => {
    const ui = new UIState();
    expect(ui.canGoBack()).toBe(false);
    ui.pushView('manga');
    expect(ui.canGoBack()).toBe(true);
    ui.popView();
    expect(ui.canGoBack()).toBe(false);
  });

  it('peekBack returns previous view without popping', () => {
    const ui = new UIState();
    expect(ui.peekBack()).toBe('list');
    ui.pushView('manga');
    expect(ui.peekBack()).toBe('list');
    ui.pushView('reader');
    expect(ui.peekBack()).toBe('manga');
  });

  it('resetTo clears stack and sets mode', () => {
    const ui = new UIState();
    ui.pushView('manga');
    ui.pushView('reader');
    ui.resetTo('list');
    expect(ui.viewMode).toBe('list');
    expect(ui.viewStack).toEqual([]);
  });

  it('setViewDirect sets mode and stack without triggering onViewChange', () => {
    const ui = new UIState();
    const onChange = vi.fn();
    ui.onViewChange = onChange;

    ui.setViewDirect('reader', ['list', 'manga']);
    expect(ui.viewMode).toBe('reader');
    expect(ui.viewStack).toEqual(['list', 'manga']);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('pushView and popView trigger onViewChange', () => {
    const ui = new UIState();
    const onChange = vi.fn();
    ui.onViewChange = onChange;

    ui.pushView('manga');
    expect(onChange).toHaveBeenCalledTimes(1);

    ui.popView();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('listViewGeneration increments when transitioning to list', () => {
    const ui = new UIState();
    const gen0 = ui.listViewGeneration;
    ui.pushView('manga');
    // Pushing non-list doesn't increment
    expect(ui.listViewGeneration).toBe(gen0);
    ui.popView();
    // Popping back to list increments
    expect(ui.listViewGeneration).toBe(gen0 + 1);
  });
});
