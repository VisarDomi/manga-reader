import { describe, it, expect, vi } from 'vitest';

const { ToastState } = await import('./toast.svelte.js');

describe('ToastState', () => {
  it('starts with empty items', () => {
    const toast = new ToastState();
    expect(toast.items).toEqual([]);
  });

  it('show adds a toast item', () => {
    const toast = new ToastState();
    toast.show('Hello');
    expect(toast.items).toHaveLength(1);
    expect(toast.items[0].message).toBe('Hello');
  });

  it('show returns a unique id', () => {
    const toast = new ToastState();
    const id1 = toast.show('First');
    const id2 = toast.show('Second');
    expect(id1).not.toBe(id2);
    expect(toast.items).toHaveLength(2);
  });

  it('dismiss removes a specific toast', () => {
    const toast = new ToastState();
    const id1 = toast.show('First');
    toast.show('Second');
    toast.dismiss(id1);
    expect(toast.items).toHaveLength(1);
    expect(toast.items[0].message).toBe('Second');
  });

  it('auto-dismisses after duration', () => {
    vi.useFakeTimers();
    const toast = new ToastState();
    toast.show('Temp', 1000);
    expect(toast.items).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    expect(toast.items).toHaveLength(0);
    vi.useRealTimers();
  });

  it('onClick callback stored on toast item', () => {
    const toast = new ToastState();
    const onClick = vi.fn();
    toast.show('Clickable', 2000, onClick);
    expect(toast.items[0].onClick).toBe(onClick);
  });
});
