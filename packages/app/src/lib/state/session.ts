import type { SearchFilters } from '@manga-reader/provider-types';
import type { Manga, ViewMode } from '../types.js';
import * as storage from '../services/storage.js';

const SESSION_KEY = 'session';

export interface SearchContext {
    query: string;
    filters: SearchFilters | undefined;
}

export interface SessionSnapshot {
    viewMode: ViewMode;
    viewStack: ViewMode[];
    activeManga?: Manga;
    targetMangaId?: string;
    searchContext?: SearchContext;
}

export function saveSession(snapshot: SessionSnapshot): void {
    storage.setJson(SESSION_KEY, snapshot);
}

export function loadSession(): SessionSnapshot | null {
    return storage.getJson<SessionSnapshot | null>(SESSION_KEY, null);
}

