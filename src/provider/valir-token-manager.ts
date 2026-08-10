import type { TokenManager } from '../core/token-manager';

const HEARTBEAT_INTERVAL_MS = 10_000;
const BACKOFF_INTERVAL_MS = 60_000;
const SESSION_REFRESH_EVERY = 5;
const MAX_CONSECUTIVE_FAILURES = 10;
const SESSION_TOKEN_KEY = 'novelshub_session_token';

interface ValirTokenManager extends TokenManager {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response | null>;
}

function objectOrNull(value: unknown, context: string): Record<string, unknown> | null {
    if (value === null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Valir ${context} is not an object`);
    }
    return value as Record<string, unknown>;
}

export function createValirTokenManager(origin: string): ValirTokenManager {
    let authenticated = false;
    let sessionChecked = false;
    let sessionRefreshInFlight: Promise<void> | null = null;
    let heartbeatCount = 0;

    async function heartbeat(): Promise<void> {
        const previousToken = localStorage.getItem(SESSION_TOKEN_KEY);
        const response = await fetch(`${origin}/api/heartbeat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionToken: previousToken, currentPage: location.pathname }),
            credentials: 'include',
        });
        if (!response.ok) throw new Error(`Valir heartbeat failed: ${response.status}`);
        const data = objectOrNull(await response.json(), 'heartbeat response');
        if (data === null) throw new Error('Valir heartbeat response is empty');
        const nextToken = data.sessionToken;
        if (typeof nextToken !== 'string' || nextToken.length === 0) {
            throw new Error('Valir heartbeat response is missing sessionToken');
        }
        localStorage.setItem(SESSION_TOKEN_KEY, nextToken);
        heartbeatCount++;
    }

    async function refreshSessionState(): Promise<void> {
        const response = await fetch(`${origin}/api/auth/session`, {
            credentials: 'include',
            cache: 'no-store',
        });
        if (!response.ok) throw new Error(`Valir session refresh failed: ${response.status}`);
        const data = objectOrNull(await response.json(), 'session response');
        authenticated = data !== null && typeof data.user === 'object' && data.user !== null;
        sessionChecked = true;
    }

    async function refreshSession(): Promise<void> {
        if (sessionRefreshInFlight !== null) return sessionRefreshInFlight;
        sessionRefreshInFlight = (async () => {
            await heartbeat();
            await refreshSessionState();
        })();
        try {
            await sessionRefreshInFlight;
        } finally {
            sessionRefreshInFlight = null;
        }
    }

    async function sessionFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response | null> {
        if (sessionRefreshInFlight !== null) await sessionRefreshInFlight;
        if (!sessionChecked) await refreshSession();
        if (!authenticated) return null;

        const requestInit = { ...init, credentials: 'include' as const };
        let response = await fetch(input, requestInit);
        if (response.status === 401) {
            await refreshSession();
            if (!authenticated) return null;
            response = await fetch(input, requestInit);
        }
        return response;
    }

    return {
        fetch: sessionFetch,

        start() {
            let stopped = false;
            let timer: number | null = null;
            let failures = 0;

            const clearTimer = () => {
                if (timer === null) return;
                window.clearTimeout(timer);
                timer = null;
            };
            const schedule = () => {
                if (stopped || document.visibilityState === 'hidden' || failures >= MAX_CONSECUTIVE_FAILURES) return;
                timer = window.setTimeout(runHeartbeat, failures >= 3 ? BACKOFF_INTERVAL_MS : HEARTBEAT_INTERVAL_MS);
            };
            const runHeartbeat = async () => {
                clearTimer();
                try {
                    await heartbeat();
                    failures = 0;
                    if (heartbeatCount % SESSION_REFRESH_EVERY === 0) await refreshSessionState();
                } catch (error) {
                    failures++;
                    console.error('Valir token manager heartbeat failed', error);
                } finally {
                    schedule();
                }
            };
            const resume = () => {
                if (document.visibilityState !== 'visible' || stopped) return;
                clearTimer();
                void runHeartbeat();
            };

            queueMicrotask(() => {
                if (stopped) return;
                void refreshSession()
                    .catch(error => {
                        failures++;
                        console.error('Valir token manager startup failed', error);
                    })
                    .finally(schedule);
            });
            document.addEventListener('visibilitychange', resume);
            window.addEventListener('pageshow', resume);

            return () => {
                stopped = true;
                clearTimer();
                document.removeEventListener('visibilitychange', resume);
                window.removeEventListener('pageshow', resume);
            };
        },
    };
}
