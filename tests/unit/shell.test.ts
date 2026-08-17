// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { startInit } from '../../src/core/shell';
import { registeredImageCount, registerImage, resetImageRegistry } from '../../src/core/image-retry';

const ops: Array<{ op: string; payload: unknown }> = [];
vi.mock('../../src/core/compute/transport', () => ({
    computeRequest: vi.fn(async (op: string, payload: unknown) => {
        ops.push({ op, payload });
    }),
    onComputeNotification: vi.fn(),
}));

function brokenImage(src: string): HTMLImageElement {
    const image = document.createElement('img');
    Object.defineProperties(image, {
        complete: { configurable: true, value: true },
        naturalWidth: { configurable: true, value: 0 },
    });
    image.src = src;
    document.body.appendChild(image);
    return image;
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetImageRegistry();
    document.body?.replaceChildren();
});

describe('startInit lifecycle', () => {
    it('waits for the optional provider hook before replacing the document', async () => {
        vi.useFakeTimers();
        const calls: string[] = [];
        let release: (() => void) | undefined;
        const waitForTakeover = vi.fn(() => new Promise<void>(resolve => {
            calls.push('wait');
            release = resolve;
        }));
        vi.spyOn(window, 'stop').mockImplementation(() => {
            calls.push('stop');
        });
        vi.spyOn(document, 'open').mockImplementation(() => {
            calls.push('open');
            return document;
        });
        vi.spyOn(document, 'close').mockImplementation(() => {
            calls.push('close');
        });

        ops.length = 0;
        const initialization = startInit('Test', { waitForTakeover });
        await Promise.resolve();

        expect(calls).toEqual(['wait']);
        expect(ops).toEqual([]);

        release?.();
        await initialization;

        expect(calls).toEqual(['wait', 'stop', 'open', 'close']);
        // Post-nuke worker context sync happens exactly once.
        expect(ops.filter(op => op.op === 'cookie-snapshot')).toHaveLength(1);

        window.dispatchEvent(new Event('pagehide'));
        expect(ops.filter(op => op.op === 'lifecycle' && (op.payload as { hidden: boolean }).hidden)).toHaveLength(1);
    });
});

describe('image retry registry', () => {
    it('drops images with missing or empty sources and stops tracking them', async () => {
        vi.useFakeTimers();
        const missingSource = document.createElement('img');
        missingSource.className = 'hs-reader-img';
        const emptySource = document.createElement('img');
        emptySource.setAttribute('src', '');
        for (const image of [missingSource, emptySource]) {
            Object.defineProperties(image, {
                complete: { configurable: true, value: true },
                naturalWidth: { configurable: true, value: 0 },
            });
        }
        document.body.append(missingSource, emptySource);
        registerImage(missingSource);
        registerImage(emptySource);
        expect(registeredImageCount()).toBe(2);

        await vi.advanceTimersByTimeAsync(1_000);

        expect(registeredImageCount()).toBe(0);
        expect(missingSource.hasAttribute('src')).toBe(false);
        expect(emptySource.getAttribute('src')).toBe('');
    });

    it('stops the timer entirely once every registered image resolved', async () => {
        vi.useFakeTimers();
        const image = brokenImage(location.origin + '/image.webp');
        registerImage(image);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(vi.getTimerCount()).toBe(1);

        Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 1200 });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(registeredImageCount()).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('retries registered images after 1, 2, 4 second delays', async () => {
        vi.useFakeTimers();
        const gallery = brokenImage(location.origin + '/image.webp');
        const cover = brokenImage(location.origin + '/cover.webp');
        registerImage(gallery);
        registerImage(cover);

        const retryValues = () => [gallery, cover].map(image => new URL(image.src).searchParams.get('retry'));
        await vi.advanceTimersByTimeAsync(999);
        expect(retryValues()).toEqual([null, null]);

        await vi.advanceTimersByTimeAsync(1);
        const afterOneSecond = retryValues();
        expect(afterOneSecond.every(Boolean)).toBe(true);

        await vi.advanceTimersByTimeAsync(1_999);
        expect(retryValues()).toEqual(afterOneSecond);
        await vi.advanceTimersByTimeAsync(1);
        const afterThreeSeconds = retryValues();
        expect(afterThreeSeconds).not.toEqual(afterOneSecond);

        await vi.advanceTimersByTimeAsync(3_999);
        expect(retryValues()).toEqual(afterThreeSeconds);
        await vi.advanceTimersByTimeAsync(1);
        expect(retryValues()).not.toEqual(afterThreeSeconds);
    });

    it('tracks exponential backoff independently per image', async () => {
        vi.useFakeTimers();
        const first = brokenImage(location.origin + '/first.webp');
        registerImage(first);

        await vi.advanceTimersByTimeAsync(7_000);
        const firstAtSevenSeconds = first.src;

        const second = brokenImage(location.origin + '/second.webp');
        registerImage(second);

        await vi.advanceTimersByTimeAsync(999);
        expect(new URL(second.src).searchParams.get('retry')).toBe(null);
        await vi.advanceTimersByTimeAsync(1);
        const secondAtEightSeconds = second.src;
        expect(new URL(secondAtEightSeconds).searchParams.get('retry')).toBeTruthy();
        expect(first.src).toBe(firstAtSevenSeconds);

        await vi.advanceTimersByTimeAsync(2_000);
        expect(second.src).not.toBe(secondAtEightSeconds);
        expect(first.src).toBe(firstAtSevenSeconds);
    });
});
