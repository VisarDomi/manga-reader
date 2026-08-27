// Worker-owned authenticated Asura requests. Tokens live in IndexedDB;
// document cookies and the current page URL arrive through worker context.

import { tokensGet, tokensPut } from '../core/compute/store';
import { workerContext } from '../core/compute/context';
import { parseAsuraRemoteHistory } from './asura-remote';
import type { ChapterData, RemoteSeriesHistory } from './types';
import { SITE_CONFIG } from '../core/sites';

const ASURA_API = SITE_CONFIG.asurascans.apiBase!;

function cookiePresent(name: string): boolean {
    return new RegExp('(?:^|;\\s*)' + name + '=1(?:;|$)').test(workerContext().cookies);
}

function notifyCookieWrite(value: string): void {
    (self as unknown as Worker).postMessage({ kind: 'notify', name: 'cookie-write', value });
}

function providerFetch(input: string, init: RequestInit = {}): Promise<Response> {
    const referrer = workerContext().href;
    return fetch(input, referrer ? { ...init, referrer } : init);
}

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
    if (typeof data.providerData !== 'object' || data.providerData === null || Array.isArray(data.providerData)) {
        throw new Error('Asura chapter tracking data is missing');
    }
    const tracking = data.providerData as Record<string, unknown>;
    const seriesId = tracking.seriesId;
    const chapterApiId = tracking.chapterId;
    if (
        (typeof seriesId !== 'number' && typeof seriesId !== 'string')
        || (typeof chapterApiId !== 'number' && typeof chapterApiId !== 'string')
    ) {
        throw new Error('Asura chapter tracking data is invalid');
    }
    if (!await asuraHasSession()) return;
    const headers = { 'Content-Type': 'application/json' };
    const responses = await Promise.all([
        asuraAuthedFetch(ASURA_API + '/bookmarks/' + seriesId + '/read/' + data.chapterId, {
            method: 'POST',
            headers,
        }),
        asuraAuthedFetch(ASURA_API + '/views/chapter', {
            method: 'POST',
            headers,
            body: JSON.stringify({ chapter_id: chapterApiId, series_id: seriesId }),
        }),
    ]);
    for (const response of responses) {
        if (!response.ok) throw new Error('Asura chapter tracking failed: ' + response.status);
    }
}
