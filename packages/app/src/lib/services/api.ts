import { API } from '../config.js';
import type { Manga, ChapterMeta, ChapterPage, SearchApiResponse, ChaptersApiResponse, ChapterImagesApiResponse, HistoryApiResponse } from '../types.js';

// --- fetchJson wrapper ---

type ApiErrorKind = 'network' | 'timeout' | 'http' | 'parse';

export class ApiError extends Error {
    constructor(
        public readonly kind: ApiErrorKind,
        public readonly status?: number,
        cause?: unknown,
    ) {
        super(
            kind === 'http' ? `HTTP ${status}` :
            kind === 'timeout' ? 'Request timed out' :
            kind === 'parse' ? 'Invalid JSON response' :
            'Network error'
        );
        this.cause = cause;
    }
}

const TRANSIENT_CODES = new Set([408, 429, 500, 502, 503, 504]);

const FETCH_TIMEOUT_MS = 12_000;

interface FetchJsonOptions {
    signal?: AbortSignal;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    retry?: boolean;
}

async function fetchJson<T = unknown>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
    const { signal: callerSignal, method, headers, body, retry = false } = opts;
    let lastError: unknown;

    const maxAttempts = retry ? 2 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 1000));
        // Combine caller signal with a timeout signal so fetches never hang forever
        const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
        const signal = callerSignal
            ? AbortSignal.any([callerSignal, timeoutSignal])
            : timeoutSignal;
        try {
            const res = await fetch(url, { signal, method, headers, body });
            if (!res.ok) {
                const err = new ApiError('http', res.status);
                if (retry && TRANSIENT_CODES.has(res.status) && attempt < maxAttempts - 1) {
                    lastError = err;
                    continue;
                }
                throw err;
            }
            try {
                return await res.json() as T;
            } catch (e) {
                throw new ApiError('parse', undefined, e);
            }
        } catch (e) {
            if (e instanceof ApiError) throw e;
            if (callerSignal?.aborted) throw e;
            if (e instanceof TypeError) {
                // fetch throws TypeError for network failures
                const err = new ApiError('network', undefined, e);
                if (retry && attempt < maxAttempts - 1) { lastError = err; continue; }
                throw err;
            }
            if (e instanceof DOMException && e.name === 'TimeoutError') {
                const err = new ApiError('timeout', undefined, e);
                if (retry && attempt < maxAttempts - 1) { lastError = err; continue; }
                throw err;
            }
            throw e;
        }
    }
    throw lastError;
}

// --- Search ---

export interface SearchFilters {
    includeTerms: number[];
    excludeTerms: number[];
    types: string[];
    statuses: string[];
}

export interface SearchResult {
    manga: Manga[];
    hasMore: boolean;
}

export async function searchManga(query: string, page = 1, filters?: SearchFilters, signal?: AbortSignal, retry = false): Promise<SearchResult> {
    const params = new URLSearchParams();
    params.set('page', String(page));
    if (query) params.set('keyword', query);

    if (filters) {
        for (const id of filters.includeTerms) params.append('genres[]', String(id));
        for (const id of filters.excludeTerms) params.append('genres[]', String(-id));
        if (filters.includeTerms.length > 0 || filters.excludeTerms.length > 0) {
            params.set('genres_mode', 'and');
        }
        for (const t of filters.types) params.append('types[]', t);
        for (const s of filters.statuses) params.append('statuses[]', s);
    }

    const url = `${API.SEARCH_BASE}?${params}`;
    const data = await fetchJson<SearchApiResponse>(url, { signal, retry });
    const items = data.result?.items ?? data.items ?? [];

    const manga: Manga[] = items.map((item: Record<string, unknown>) => {
        const m = (item as Record<string, unknown>);
        const poster = m.poster as Record<string, string> | null;
        // Chapters API uses hash_id (e.g. "45z4"), not the full slug
        const hashId = String(m.hash_id ?? '');
        const slug = String(m.slug ?? '');
        return {
            slug: hashId || slug,
            title: String(m.title ?? ''),
            cover: poster?.medium ?? poster?.large ?? poster?.small ?? '',
            latestChapter: m.latest_chapter != null ? Number(m.latest_chapter) : null,
            author: m.author ? String(m.author) : undefined,
            status: m.status ? String(m.status) : undefined,
            termIds: Array.isArray(m.term_ids) ? m.term_ids.map(Number) : undefined,
        } satisfies Manga;
    });

    const hasMore = manga.length >= 30;
    return { manga, hasMore };
}

// --- Chapters ---

export async function fetchChapterList(slug: string, signal?: AbortSignal): Promise<ChapterMeta[]> {
    // Fetch pages 1-5 in parallel (100 per page = 500 max chapters)
    const pages = [1, 2, 3, 4, 5];
    const results = await Promise.all(
        pages.map(page =>
            fetchJson<ChaptersApiResponse>(API.CHAPTERS(slug, page), { signal })
                .catch((e) => {
                    if (signal?.aborted) throw e;
                    return null;
                })
        )
    );

    const allItems: ChapterMeta[] = [];
    const seen = new Set<number>();

    for (const data of results) {
        const items = data?.result?.items ?? [];
        for (const item of items) {
            const chapterId = Number(item.chapter_id);
            if (seen.has(chapterId)) continue;
            seen.add(chapterId);

            allItems.push({
                chapterId,
                number: parseFloat(item.number),
                scanlationGroupId: Number(item.scanlation_group_id),
                scanlationGroupName: item.scanlation_group?.name ?? 'Unknown',
                votes: Number(item.votes ?? 0),
                mangaId: item.manga_id != null ? Number(item.manga_id) : undefined,
                uploadedAt: item.created_at != null ? Number(item.created_at) : undefined,
            });
        }
    }

    return allItems;
}

// --- Chapter Images ---

export async function fetchChapterImages(slug: string, chapterId: number, chapterNumber: number): Promise<ChapterPage[]> {
    const data = await fetchJson<ChapterImagesApiResponse>(API.CHAPTER_IMAGES(slug, chapterId, chapterNumber), { retry: true });
    return (data.images ?? []).map((img) => ({
        url: String(img.url ?? ''),
        width: Number(img.width ?? 0),
        height: Number(img.height ?? 0),
    }));
}

// --- History ---

export async function updateHistory(mangaId: number, chapterId: number): Promise<boolean> {
    try {
        await fetchJson(API.HISTORY_UPDATE(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                manga_id: mangaId,
                chapter_id: chapterId,
                current_page: 1,
                total_page: 20,
            }),
            retry: true,
        });
        return true;
    } catch {
        return false;
    }
}

export async function getHistory(mangaId: number): Promise<number | null> {
    try {
        const data = await fetchJson<HistoryApiResponse>(API.HISTORY_GET(mangaId));
        const chId = data.result?.chapter_id ?? data.result?.chapter?.chapter_id;
        return chId ? Number(chId) : null;
    } catch {
        return null;
    }
}

// --- Favorites ---

export async function fetchFavorites(): Promise<Manga[]> {
    const data = await fetchJson<{ items: Manga[] }>(API.FAVORITES);
    return data.items ?? [];
}

export async function addFavorite(manga: Manga): Promise<void> {
    await fetchJson(API.FAVORITE(manga.slug), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title: manga.title,
            cover: manga.cover,
            latestChapter: manga.latestChapter,
            author: manga.author,
            status: manga.status,
            termIds: manga.termIds,
        }),
    });
}

export async function removeFavorite(slug: string): Promise<void> {
    await fetchJson(API.FAVORITE(slug), { method: 'DELETE' });
}
