// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForValirTakeover } from '../../src/provider/valir';

afterEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
    vi.restoreAllMocks();
});

describe('provider takeover readiness', () => {
    it('keeps Valir pending on Cloudflare markup until the normal Next.js payload appears', async () => {
        const readiness = waitForValirTakeover();
        let resolved = false;
        void readiness.then(() => {
            resolved = true;
        });

        const challenge = document.createElement('script');
        challenge.src = '/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1';
        const response = document.createElement('input');
        response.name = 'cf-turnstile-response';
        document.head.append(challenge);
        document.body.append(response);
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(resolved).toBe(false);

        const persistedPageHide = new Event('pagehide');
        Object.defineProperty(persistedPageHide, 'persisted', { value: true });
        window.dispatchEvent(persistedPageHide);

        const flight = document.createElement('script');
        flight.type = 'application/json';
        flight.textContent = 'self.__next_f.push([1, "normal Valir page"]);';
        document.body.append(flight);

        await expect(readiness).resolves.toBeUndefined();
    });

    it('resolves Valir immediately when its Next.js payload already exists', async () => {
        const flight = document.createElement('script');
        flight.type = 'application/json';
        flight.textContent = 'self.__next_f.push([1, "normal Valir page"]);';
        document.head.append(flight);

        await expect(waitForValirTakeover()).resolves.toBeUndefined();
    });
});
