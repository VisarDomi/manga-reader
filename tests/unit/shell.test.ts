// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { startInit } from '../../src/core/shell';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body?.replaceChildren();
});

describe('broken image retries', () => {
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
});
