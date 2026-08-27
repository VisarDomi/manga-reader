// Worker-side provider registry. Core owns scheduling and transport; this
// module owns which provider implementation satisfies each requested action.

import type { ChapterData, HomePage, RemoteSeriesHistory } from './types';
import type { Site } from '../core/sites';
import { workerContext } from '../core/compute/context';
import { fetchAngularHome } from './angular-catalog';
import { fetchAsuraHome } from './asura-catalog';
import { fetchLuaHome } from './lua-catalog';
import { fetchAsuraRemoteHistory, trackAsuraChapter } from './asura-session';

const catalogs: Record<string, (cursor: string | null, referrer?: string) => Promise<HomePage>> = {
    asurascans: fetchAsuraHome,
    ezmanga: (cursor, referrer) => fetchAngularHome('ezmanga' as Site, cursor, referrer),
    qimanga: (cursor, referrer) => fetchAngularHome('qimanga' as Site, cursor, referrer),
    luacomic: fetchLuaHome,
};

const remoteHistories: Record<string, () => Promise<RemoteSeriesHistory[]>> = {
    asurascans: fetchAsuraRemoteHistory,
};

const chapterTrackers: Record<string, (data: ChapterData) => Promise<void>> = {
    asurascans: trackAsuraChapter,
};

export function fetchProviderHome(provider: string, cursor: string | null): Promise<HomePage> {
    const fetchHome = catalogs[provider];
    if (!fetchHome) throw new Error(`Provider ${provider} has no worker catalog`);
    return fetchHome(cursor, workerContext().href);
}

export function fetchProviderRemoteHistory(provider: string): Promise<RemoteSeriesHistory[]> {
    const fetchHistory = remoteHistories[provider];
    if (!fetchHistory) throw new Error(`Provider ${provider} has no remote history`);
    return fetchHistory();
}

export function trackProviderChapter(provider: string, data: ChapterData): Promise<void> {
    const trackChapter = chapterTrackers[provider];
    if (!trackChapter) throw new Error(`Provider ${provider} has no chapter tracker`);
    return trackChapter(data);
}
