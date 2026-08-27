// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerImage, resetImageRegistry } from '../../src/core/image-retry';

afterEach(() => {
    vi.useRealTimers();
    resetImageRegistry();
    document.body.replaceChildren();
});

describe('image self-registration', () => {
    it('retries a registered image that failed to load', async () => {
        vi.useFakeTimers();
        const image = document.createElement('img');
        Object.defineProperties(image, {
            complete: { configurable: true, value: true },
            naturalWidth: { configurable: true, value: 0 },
        });
        image.src = `${location.origin}/image.webp`;
        document.body.appendChild(image);

        registerImage(image);
        await vi.advanceTimersByTimeAsync(1_000);

        expect(new URL(image.src).searchParams.get('retry')).toBeTruthy();
    });
});
