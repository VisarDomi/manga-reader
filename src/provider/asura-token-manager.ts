import type { TokenManager } from '../core/token-manager';

const REFRESH_INTERVAL_MS = 30 * 60_000;

interface AsuraTokenManager extends TokenManager {
    hasSession(): boolean;
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

function record(value: unknown, context: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`Asura ${context} is not an object`);
    }
    return value as Record<string, unknown>;
}

function loggedInCookiePresent(): boolean {
    return /(?:^|;\s*)logged_in=1(?:;|$)/.test(document.cookie);
}

export function createAsuraTokenManager(apiBase: string): AsuraTokenManager {
    let refreshInFlight: Promise<string> | null = null;

    function canRefresh(): boolean {
        return localStorage.getItem('refresh_token') !== null || loggedInCookiePresent();
    }

    async function refreshAccessToken(): Promise<string> {
        if (refreshInFlight !== null) return refreshInFlight;
        refreshInFlight = (async () => {
            const refreshToken = localStorage.getItem('refresh_token');
            if (refreshToken === null && !loggedInCookiePresent()) {
                throw new Error('Asura has no refresh credentials');
            }
            const response = await fetch(`${apiBase}/auth/refresh`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(refreshToken === null ? {} : { refresh_token: refreshToken }),
                credentials: 'include',
            });
            if (!response.ok) throw new Error(`Asura token refresh failed: ${response.status}`);
            const envelope = record(await response.json(), 'token refresh response');
            const data = record(envelope.data, 'token refresh data');
            const accessToken = data.access_token;
            if (typeof accessToken !== 'string' || accessToken.length === 0) {
                throw new Error('Asura token refresh data is missing access_token');
            }
            const rotatedRefreshToken = data.refresh_token;
            if (rotatedRefreshToken !== undefined && rotatedRefreshToken !== null && typeof rotatedRefreshToken !== 'string') {
                throw new Error('Asura token refresh data has an invalid refresh_token');
            }

            localStorage.setItem('access_token', accessToken);
            document.cookie = `access_token=${accessToken};path=/;max-age=86400`;
            if (typeof rotatedRefreshToken === 'string' && rotatedRefreshToken.length > 0) {
                localStorage.setItem('refresh_token', rotatedRefreshToken);
                document.cookie = `refresh_token=${rotatedRefreshToken};path=/;max-age=2592000`;
            }
            return accessToken;
        })();
        try {
            return await refreshInFlight;
        } finally {
            refreshInFlight = null;
        }
    }

    function requestWithToken(input: RequestInfo | URL, init: RequestInit, accessToken: string): Promise<Response> {
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Bearer ${accessToken}`);
        return fetch(input, { ...init, headers });
    }

    async function authenticatedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
        if (refreshInFlight !== null) await refreshInFlight;
        let accessToken = localStorage.getItem('access_token');
        if (accessToken === null && canRefresh()) accessToken = await refreshAccessToken();
        if (accessToken === null) throw new Error('Asura has no authenticated session');

        let response = await requestWithToken(input, init, accessToken);
        if (response.status === 401 && canRefresh()) {
            accessToken = await refreshAccessToken();
            response = await requestWithToken(input, init, accessToken);
        }
        return response;
    }

    return {
        hasSession() {
            return localStorage.getItem('access_token') !== null || canRefresh();
        },

        fetch: authenticatedFetch,

        start() {
            let stopped = false;
            const refresh = () => {
                if (stopped || !canRefresh()) return;
                void refreshAccessToken().catch(error => console.error('Asura token refresh failed', error));
            };
            queueMicrotask(refresh);
            const interval = window.setInterval(refresh, REFRESH_INTERVAL_MS);
            window.addEventListener('pageshow', refresh);
            return () => {
                stopped = true;
                window.clearInterval(interval);
                window.removeEventListener('pageshow', refresh);
            };
        },
    };
}
