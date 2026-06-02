import type { SearchFilters } from '@manga-reader/provider-types';
import type { Manga, ViewMode } from '../types.js';
import * as storage from '../services/storage.js';

const SESSION_KEY = 'session';

export interface SearchContext {
    query: string;
    filters: SearchFilters | undefined;
}

export interface MangaScrollSnapshot {
    mangaId: string;
    stackIndex?: number;
    scrollTop: number;
}

export interface SessionSnapshot {
    providerId?: string;
    viewMode: ViewMode;
    viewStack: ViewMode[];
    activeManga?: Manga;
    mangaStack?: Manga[];
    targetMangaId?: string;
    searchContext?: SearchContext;
    mangaScroll?: MangaScrollSnapshot;
    mangaScrolls?: MangaScrollSnapshot[];
}

export function saveSession(snapshot: SessionSnapshot): void {
    storage.setJson(SESSION_KEY, snapshot);
}

export function loadSession(): SessionSnapshot | null {
    return storage.getJson<SessionSnapshot | null>(SESSION_KEY, null);
}
