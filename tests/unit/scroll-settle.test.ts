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

it('waits 100 ms and coalesces consecutive scrollend events', () => {
    const save = vi.fn();
    onSettledScroll(save);
    dispatchEvent(new Event('scrollend'));
    vi.advanceTimersByTime(99);
    expect(save).not.toHaveBeenCalled();
    dispatchEvent(new Event('scrollend'));
    vi.advanceTimersByTime(99);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledTimes(1);
});

it('does not save or append while scrolling resumes, including image-load requests', () => {
    const save = vi.fn();
    const request = onSettledScroll(save);
    dispatchEvent(new Event('scrollend'));
    vi.advanceTimersByTime(50);
    dispatchEvent(new Event('scroll'));
    request();
    vi.advanceTimersByTime(200);
    expect(save).not.toHaveBeenCalled();
    dispatchEvent(new Event('scrollend'));
    vi.advanceTimersByTime(100);
    expect(save).toHaveBeenCalledTimes(1);
});

it('drops a pending update on pagehide and accepts fresh work after bfcache restoration', () => {
    const save = vi.fn();
    const request = onSettledScroll(save);
    dispatchEvent(new Event('scrollend'));
    dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
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
    vi.advanceTimersByTime(99);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledTimes(1);
});

it('never writes while hidden or replays the pre-hide timer after becoming visible', () => {
    const save = vi.fn();
    onSettledScroll(save);
    dispatchEvent(new Event('scrollend'));
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
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
