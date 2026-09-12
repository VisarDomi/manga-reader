// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { onSettledScroll } from '../../src/core/scroll-settle';

let windowListeners: ReturnType<typeof vi.spyOn>;
let documentListeners: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
    vi.useFakeTimers();
    windowListeners = vi.spyOn(window, 'addEventListener');
    documentListeners = vi.spyOn(document, 'addEventListener');
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
});
afterEach(() => {
    for (const [type, callback] of windowListeners.mock.calls) window.removeEventListener(type, callback);
    for (const [type, callback] of documentListeners.mock.calls) document.removeEventListener(type, callback);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

it('saves immediately on scrollend without a timer', () => {
    const save = vi.fn();
    onSettledScroll(save);
    dispatchEvent(new Event('scrollend'));
    expect(save).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    dispatchEvent(new Event('scrollend'));
    expect(save).toHaveBeenCalledTimes(2);
});

it('does not save or append while scrolling resumes, including image-load requests', () => {
    const save = vi.fn();
    const request = onSettledScroll(save);
    dispatchEvent(new Event('scroll'));
    request();
    vi.advanceTimersByTime(200);
    expect(save).not.toHaveBeenCalled();
    dispatchEvent(new Event('scrollend'));
    vi.advanceTimersByTime(100);
    expect(save).toHaveBeenCalledTimes(1);
});

it('ignores updates after pagehide and accepts fresh work after bfcache restoration', () => {
    const save = vi.fn();
    const request = onSettledScroll(save);
    dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    request();
    dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    vi.advanceTimersByTime(100);
    expect(save).not.toHaveBeenCalled();
    request();
    vi.advanceTimersByTime(100);
    expect(save).toHaveBeenCalledTimes(1);
});

it('does not mistake a pause under a held finger for settled scrolling', () => {
    const save = vi.fn();
    const request = onSettledScroll(save);
    dispatchEvent(new TouchEvent('touchstart'));
    dispatchEvent(new Event('scrollend'));
    request();
    vi.advanceTimersByTime(200);
    expect(save).not.toHaveBeenCalled();
    dispatchEvent(new TouchEvent('touchend', { touches: [] }));
    expect(save).toHaveBeenCalledTimes(1);
});

it('never writes while hidden or replays hidden updates after becoming visible', () => {
    const save = vi.fn();
    onSettledScroll(save);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    dispatchEvent(new Event('scrollend'));
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(100);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(100);
    expect(save).not.toHaveBeenCalled();
    dispatchEvent(new Event('scrollend'));
    vi.advanceTimersByTime(100);
    expect(save).toHaveBeenCalledTimes(1);
});
