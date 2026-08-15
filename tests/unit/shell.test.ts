// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { startInit } from '../../src/core/shell';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body?.replaceChildren();
});

describe('broken image retries', () => {
    it('ignores images with missing or empty sources', async () => {
        vi.useFakeTimers();
        vi.spyOn(window, 'stop').mockImplementation(() => undefined);
        vi.spyOn(document, 'open').mockImplementation(() => document);
        vi.spyOn(document, 'close').mockImplementation(() => undefined);
        startInit('Test');

        const missingSource = document.createElement('img');
        missingSource.className = 'hs-reader-img';
        const emptySource = document.createElement('img');
        emptySource.setAttribute('src', '');
        const coverLink = document.createElement('a');
        coverLink.className = 'hs-home-cover';
        coverLink.appendChild(emptySource);
        for (const image of [missingSource, emptySource]) {
            Object.defineProperties(image, {
                complete: { configurable: true, value: true },
                naturalWidth: { configurable: true, value: 0 },
            });
        }
        document.body.append(missingSource, coverLink);

        await vi.advanceTimersByTimeAsync(1_000);

        expect(missingSource.hasAttribute('src')).toBe(false);
        expect(emptySource.getAttribute('src')).toBe('');
    });

    it('retries gallery images and manga covers after 1, 2, 4 second delays', async () => {
        vi.useFakeTimers();
        vi.spyOn(window, 'stop').mockImplementation(() => undefined);
        vi.spyOn(document, 'open').mockImplementation(() => document);
        vi.spyOn(document, 'close').mockImplementation(() => undefined);
        startInit('Test');

        const gallery = document.createElement('img');
        gallery.className = 'hs-reader-img';
        const cover = document.createElement('img');
        const coverLink = document.createElement('a');
        coverLink.className = 'hs-home-cover';
        coverLink.appendChild(cover);
        for (const image of [gallery, cover]) {
            Object.defineProperties(image, {
                complete: { configurable: true, value: true },
                naturalWidth: { configurable: true, value: 0 },
            });
            image.src = `${location.origin}/image.webp`;
        }
        document.body.append(gallery, coverLink);

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

    it('tracks exponential backoff independently for images in the same scope', async () => {
        vi.useFakeTimers();
        vi.spyOn(window, 'stop').mockImplementation(() => undefined);
        vi.spyOn(document, 'open').mockImplementation(() => document);
        vi.spyOn(document, 'close').mockImplementation(() => undefined);
        startInit('Test');

        const first = document.createElement('img');
        first.className = 'hs-reader-img';
        Object.defineProperties(first, {
            complete: { configurable: true, value: true },
            naturalWidth: { configurable: true, value: 0 },
        });
        first.src = `${location.origin}/first.webp`;
        document.body.appendChild(first);

        await vi.advanceTimersByTimeAsync(7_000);
        const firstAtSevenSeconds = first.src;

        const second = document.createElement('img');
        second.className = 'hs-reader-img';
        Object.defineProperties(second, {
            complete: { configurable: true, value: true },
            naturalWidth: { configurable: true, value: 0 },
        });
        second.src = `${location.origin}/second.webp`;
        document.body.appendChild(second);

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
