// Worker-owned token managers and authenticated provider requests.
// Replaces the main-thread asura/valir token managers: tokens live in the
// IndexedDB 'tokens' store, and document cookies arrive via snapshots pushed
// from the main thread ('cookie-snapshot'), with write-backs sent back as
// 'cookie-write' notifications (workers cannot touch document.cookie).

import { tokensGet, tokensPut } from './store';
import { workerContext } from './context';
import { parseAsuraRemoteHistory } from '../../provider/asura-remote';
import { buildValirReadingPosition, parseValirRemoteHistory } from '../../provider/valir-remote';
import type { ChapterData, ChapterMeta, RemoteSeriesHistory } from '../../provider/types';
import { SITE_CONFIG } from '../../core/sites';

const ASURA_API = SITE_CONFIG.asurascans.apiBase!;
const VALIR_DOMAIN = SITE_CONFIG['valirscans'].domain;
const HEARTBEAT_INTERVAL_MS = 10_000;
const BACKOFF_INTERVAL_MS = 60_000;
const SESSION_REFRESH_EVERY = 5;
const MAX_CONSECUTIVE_FAILURES = 10;

function cookiePresent(name: string): boolean {
    return new RegExp('(?:^|;\\s*)' + name + '=1(?:;|$)').test(workerContext().cookies);
}

function notifyCookieWrite(value: string): void {
    (self as unknown as Worker).postMessage({ kind: 'notify', name: 'cookie-write', value });
}

/** All worker-side provider fetches carry the page URL as the referrer:
 * Cloudflare-fronted APIs can reject requests whose Referer is not the page. */
function providerFetch(input: string, init: RequestInit = {}): Promise<Response> {
    const referrer = workerContext().href;
    return fetch(input, referrer ? { ...init, referrer } : init);
}

// ── asura ────────────────────────────────────────────────────────────

interface AsuraState {
    refreshInFlight: Promise<string> | null;
}

const asuraState: AsuraState = { refreshInFlight: null };

async function asuraCanRefresh(): Promise<boolean> {
    return await tokensGet('asura:refresh_token') !== undefined || cookiePresent('logged_in');
}

async function asuraRefreshAccessToken(): Promise<string> {
    if (asuraState.refreshInFlight !== null) return asuraState.refreshInFlight;
    asuraState.refreshInFlight = (async () => {
        const refreshToken = await tokensGet('asura:refresh_token');
        if (refreshToken === undefined && !cookiePresent('logged_in')) {
            throw new Error('Asura has no refresh credentials');
        }
        const response = await providerFetch(ASURA_API + '/auth/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
            credentials: 'include',
        });
        if (!response.ok) throw new Error('Asura token refresh failed: ' + response.status);
        const envelope = await response.json() as { data?: { access_token?: unknown; refresh_token?: unknown } };
        const data = envelope.data ?? {};
        const accessToken = data.access_token;
        if (typeof accessToken !== 'string' || accessToken.length === 0) {
            throw new Error('Asura token refresh data is missing access_token');
        }
        await tokensPut('asura:access_token', accessToken);
        let cookieWrite = 'access_token=' + accessToken + ';path=/;max-age=86400';
        const rotated = data.refresh_token;
        if (typeof rotated === 'string' && rotated.length > 0) {
            await tokensPut('asura:refresh_token', rotated);
            cookieWrite += '; refresh_token=' + rotated + ';path=/;max-age=2592000';
        }
        notifyCookieWrite(cookieWrite);
        return accessToken;
    })();
    try {
        return await asuraState.refreshInFlight;
    } finally {
        asuraState.refreshInFlight = null;
    }
}

async function asuraAuthedFetch(input: string, init: RequestInit = {}): Promise<Response> {
    if (asuraState.refreshInFlight !== null) await asuraState.refreshInFlight;
    let accessToken = await tokensGet('asura:access_token');
    if (accessToken === undefined && await asuraCanRefresh()) accessToken = await asuraRefreshAccessToken();
    if (typeof accessToken !== 'string') throw new Error('Asura has no authenticated session');

    const headers = new Headers(init.headers);
    headers.set('Authorization', 'Bearer ' + accessToken);
    let response = await providerFetch(input, { ...init, headers });
    if (response.status === 401 && await asuraCanRefresh()) {
        accessToken = await asuraRefreshAccessToken();
        headers.set('Authorization', 'Bearer ' + accessToken);
        response = await providerFetch(input, { ...init, headers });
    }
    return response;
}

async function asuraHasSession(): Promise<boolean> {
    return await tokensGet('asura:access_token') !== undefined || await asuraCanRefresh();
}

export async function fetchAsuraRemoteHistory(): Promise<RemoteSeriesHistory[]> {
    if (!await asuraHasSession()) return [];
    const response = await asuraAuthedFetch(ASURA_API + '/me/read-chapters');
    if (!response.ok) throw new Error('Asura read history failed: ' + response.status);
    return parseAsuraRemoteHistory(await response.json());
}

export async function trackAsuraChapter(data: ChapterData): Promise<void> {
    if (!data.seriesApiId || !data.chapterApiId || !await asuraHasSession()) return;
    const headers = { 'Content-Type': 'application/json' };
    const responses = await Promise.all([
        asuraAuthedFetch(ASURA_API + '/bookmarks/' + data.seriesApiId + '/read/' + data.chapterId, {
            method: 'POST',
            headers,
        }),
        asuraAuthedFetch(ASURA_API + '/views/chapter', {
            method: 'POST',
            headers,
            body: JSON.stringify({ chapter_id: data.chapterApiId, series_id: data.seriesApiId }),
        }),
    ]);
    for (const response of responses) {
        if (!response.ok) throw new Error('Asura chapter tracking failed: ' + response.status);
    }
}

// ── valir ────────────────────────────────────────────────────────────

interface ValirState {
    authenticated: boolean;
    sessionChecked: boolean;
    sessionRefreshInFlight: Promise<void> | null;
    heartbeatCount: number;
    failures: number;
    timer: number | null;
}

const valirState: ValirState = {
    authenticated: false,
    sessionChecked: false,
    sessionRefreshInFlight: null,
    heartbeatCount: 0,
    failures: 0,
    timer: null,
};

function objectOrNull(value: unknown, contextName: string): Record<string, unknown> | null {
    if (value === null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Valir ' + contextName + ' is not an object');
    }
    return value as Record<string, unknown>;
}

async function valirHeartbeat(): Promise<void> {
    const previousToken = await tokensGet('valir:session');
    const response = await providerFetch('https://' + VALIR_DOMAIN + '/api/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionToken: previousToken ?? null, currentPage: workerContext().pathname }),
        credentials: 'include',
    });
    if (!response.ok) throw new Error('Valir heartbeat failed: ' + response.status);
    const data = objectOrNull(await response.json(), 'heartbeat response');
    if (data === null) throw new Error('Valir heartbeat response is empty');
    const nextToken = data.sessionToken;
    if (typeof nextToken !== 'string' || nextToken.length === 0) {
        throw new Error('Valir heartbeat response is missing sessionToken');
    }
    await tokensPut('valir:session', nextToken);
    valirState.heartbeatCount++;
}

async function valirRefreshSessionState(): Promise<void> {
    const response = await providerFetch('https://' + VALIR_DOMAIN + '/api/auth/session', {
        credentials: 'include',
        cache: 'no-store',
    });
    if (!response.ok) throw new Error('Valir session refresh failed: ' + response.status);
    const data = objectOrNull(await response.json(), 'session response');
    valirState.authenticated = data !== null && typeof data.user === 'object' && data.user !== null;
    valirState.sessionChecked = true;
}

async function valirRefreshSession(): Promise<void> {
    if (valirState.sessionRefreshInFlight !== null) return valirState.sessionRefreshInFlight;
    valirState.sessionRefreshInFlight = (async () => {
        await valirHeartbeat();
        await valirRefreshSessionState();
    })();
    try {
        await valirState.sessionRefreshInFlight;
    } finally {
        valirState.sessionRefreshInFlight = null;
    }
}

async function valirSessionFetch(input: string, init: RequestInit = {}): Promise<Response | null> {
    if (valirState.sessionRefreshInFlight !== null) await valirState.sessionRefreshInFlight;
    if (!valirState.sessionChecked) await valirRefreshSession();
    if (!valirState.authenticated) return null;

    const requestInit = { ...init, credentials: 'include' as const };
    let response = await providerFetch(input, requestInit);
    if (response.status === 401) {
        await valirRefreshSession();
        if (!valirState.authenticated) return null;
        response = await providerFetch(input, requestInit);
    }
    return response;
}

function valirSchedule(): void {
    if (valirState.timer !== null) {
        self.clearTimeout(valirState.timer);
        valirState.timer = null;
    }
    if (workerContext().hidden || valirState.failures >= MAX_CONSECUTIVE_FAILURES) return;
    valirState.timer = self.setTimeout(
        () => { void valirRunHeartbeat(); },
        valirState.failures >= 3 ? BACKOFF_INTERVAL_MS : HEARTBEAT_INTERVAL_MS,
    );
}

async function valirRunHeartbeat(): Promise<void> {
    try {
        await valirHeartbeat();
        valirState.failures = 0;
        if (valirState.heartbeatCount % SESSION_REFRESH_EVERY === 0) await valirRefreshSessionState();
    } catch (error) {
        valirState.failures++;
        console.error('Valir token manager heartbeat failed', error);
    } finally {
        valirSchedule();
    }
}

export function startWorkerTokenManagers(): void {
    void valirRefreshSession()
        .catch(error => {
            valirState.failures++;
            console.error('Valir token manager startup failed', error);
        })
        .finally(valirSchedule);
    valirSchedule();
}

export async function fetchValirRemoteHistory(): Promise<RemoteSeriesHistory[]> {
    const response = await valirSessionFetch('https://' + VALIR_DOMAIN + '/api/continue-reading');
    if (response === null) return [];
    if (!response.ok) throw new Error('Valir continue reading failed: ' + response.status);
    return parseValirRemoteHistory(await response.json());
}

export async function trackValirPage(
    data: ChapterData,
    imageIndex: string,
    chaptersNewestFirst: ChapterMeta[],
): Promise<void> {
    const position = buildValirReadingPosition(data, imageIndex, chaptersNewestFirst);
    if (position === null) return;

    const response = await valirSessionFetch('https://' + VALIR_DOMAIN + '/api/chapters/reading-position', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(position),
    });
    if (response !== null && !response.ok) {
        throw new Error('Valir reading position failed: ' + response.status);
    }
}
