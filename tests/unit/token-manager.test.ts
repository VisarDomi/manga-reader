// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsuraTokenManager } from '../../src/provider/asura-token-manager';
import { createValirTokenManager } from '../../src/provider/valir-token-manager';

afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('Asura token manager', () => {
    it('refreshes an expired access token and retries the authenticated request once', async () => {
        localStorage.setItem('access_token', 'expired-access');
        localStorage.setItem('refresh_token', 'refresh-one');
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.endsWith('/auth/refresh')) {
                return new Response(JSON.stringify({
                    data: { access_token: 'fresh-access', refresh_token: 'refresh-two' },
                }));
            }
            const authorization = new Headers(init?.headers).get('Authorization');
            return authorization === 'Bearer expired-access'
                ? new Response(null, { status: 401 })
                : new Response(JSON.stringify({ ok: true }));
        });
        vi.stubGlobal('fetch', fetchMock);
        const manager = createAsuraTokenManager('https://api.asurascans.com/api');

        const response = await manager.fetch('https://api.asurascans.com/api/me/read-chapters');

        expect(response.ok).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(String(fetchMock.mock.calls[1][0])).toBe('https://api.asurascans.com/api/auth/refresh');
        expect(fetchMock.mock.calls[1][1]).toMatchObject({
            method: 'POST',
            credentials: 'include',
            body: JSON.stringify({ refresh_token: 'refresh-one' }),
        });
        expect(localStorage.getItem('access_token')).toBe('fresh-access');
        expect(localStorage.getItem('refresh_token')).toBe('refresh-two');
        expect(new Headers(fetchMock.mock.calls[2][1]?.headers).get('Authorization')).toBe('Bearer fresh-access');
    });

    it('starts an immediate refresh cycle without blocking its caller', async () => {
        vi.useFakeTimers();
        localStorage.setItem('refresh_token', 'refresh-token');
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            data: { access_token: 'fresh-access' },
        })));
        vi.stubGlobal('fetch', fetchMock);
        const manager = createAsuraTokenManager('https://api.asurascans.com/api');

        const stop = manager.start();
        expect(fetchMock).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(0);
        stop();

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(localStorage.getItem('access_token')).toBe('fresh-access');
    });
});

describe('Valir token manager', () => {
    it('establishes heartbeat/session state before tracking and refreshes on 401', async () => {
        let readingPositionRequests = 0;
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/api/heartbeat')) {
                return new Response(JSON.stringify({ success: true, sessionToken: `heartbeat-${fetchMock.mock.calls.length}` }));
            }
            if (url.endsWith('/api/auth/session')) {
                return new Response(JSON.stringify({ user: { id: 'reader' } }));
            }
            readingPositionRequests++;
            return new Response(null, { status: readingPositionRequests === 1 ? 401 : 200 });
        });
        vi.stubGlobal('fetch', fetchMock);
        const manager = createValirTokenManager('https://valirscans.org');

        const response = await manager.fetch('https://valirscans.org/api/chapters/reading-position', {
            method: 'POST',
        });

        expect(response?.ok).toBe(true);
        expect(fetchMock.mock.calls.map(call => new URL(String(call[0])).pathname)).toEqual([
            '/api/heartbeat',
            '/api/auth/session',
            '/api/chapters/reading-position',
            '/api/heartbeat',
            '/api/auth/session',
            '/api/chapters/reading-position',
        ]);
        expect(localStorage.getItem('novelshub_session_token')).toMatch(/^heartbeat-/);
    });

    it('does not send server history when the refreshed session is signed out', async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/api/heartbeat')
            ? new Response(JSON.stringify({ success: true, sessionToken: 'anonymous-heartbeat' }))
            : new Response('null'));
        vi.stubGlobal('fetch', fetchMock);
        const manager = createValirTokenManager('https://valirscans.org');

        await expect(manager.fetch('https://valirscans.org/api/chapters/reading-position')).resolves.toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
