import { fetchJson, ApiError, ApiErrKind } from './fetchJson.js';
import { getProvider, getProviderId } from './provider.js';
import type { Manga, ChapterMeta, ChapterPage, MangaComment, MangaCommentStats } from '../types.js';
import type { FavoriteBackupRow } from './db.js';
import type { SearchFilters, ChapterListPage } from '@manga-reader/provider-types';
import type { LogEmit } from './LogService.js';

export { ApiError, ApiErrKind } from './fetchJson.js';
let emit: LogEmit = (() => {}) as unknown as LogEmit;

export function setApiLogger(fn: LogEmit): void {
    emit = fn;
}

export function setCloudflareCallback(cb: () => void): void {
    void cb;
}

const CACHE_WARM_POLL_MS = 500;
const CACHE_WARM_ATTEMPTS = 1;
const MANGA_DETAIL_CACHE_TIMEOUT_MS = 30_000;
const CHAPTER_IMAGE_CACHE_TIMEOUT_MS = 30_000;
const COMMENTS_FETCH_TIMEOUT_MS = 45_000;
const SEARCH_FETCH_TIMEOUT_MS = 45_000;

function providerQueryParam(): string {
    return `providerId=${encodeURIComponent(getProviderId())}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        }, { once: true });
    });
}

function cacheStatus(data: unknown): string | null {
    return data && typeof data === 'object' && typeof (data as Record<string, unknown>).status === 'string'
        ? (data as Record<string, unknown>).status as string
        : null;
}

function cacheUpdating(data: unknown): boolean {
    const root = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    const cache = root.cache && typeof root.cache === 'object' ? root.cache as Record<string, unknown> : {};
    return cache.updating === true;
}

type CacheResource = 'manga-detail' | 'chapter-list' | 'chapter-images';
type CachePriority = 'interactive' | 'foreground' | 'observed';

interface CachedPayloadResult {
    data: unknown;
    attempts: number;
    updating: boolean;
}

interface CachedPayloadPeek {
    status: 'hit' | 'warming';
    data?: unknown;
    updating?: boolean;
}

async function fetchCachedPayloadWithMeta(url: string, signal: AbortSignal | undefined, resource: CacheResource, mangaId: string, chapterId?: string, timeoutMs?: number): Promise<CachedPayloadResult> {
    const providerId = getProviderId();
    for (let attempt = 0; attempt < CACHE_WARM_ATTEMPTS; attempt++) {
        const data = await fetchJson<unknown>(url, { signal, timeoutMs });
        if (cacheStatus(data) !== 'warming') {
            const updating = cacheUpdating(data);
            emit('cache-read', { providerId, resource, action: 'hit', mangaId, chapterId, count: attempt, updating });
            return { data, attempts: attempt, updating };
        }
        emit('cache-read', { providerId, resource, action: 'warming', mangaId, chapterId, count: attempt + 1 });
        await sleep(CACHE_WARM_POLL_MS, signal);
    }
    emit('cache-read', { providerId, resource, action: 'miss', mangaId, chapterId, count: CACHE_WARM_ATTEMPTS });
    throw new Error(`Cache warming timed out for ${resource}`);
}

async function fetchCachedPayload(url: string, signal: AbortSignal | undefined, resource: CacheResource, mangaId: string, chapterId?: string, timeoutMs?: number): Promise<unknown> {
    return (await fetchCachedPayloadWithMeta(url, signal, resource, mangaId, chapterId, timeoutMs)).data;
}

async function peekCachedPayload(url: string, signal: AbortSignal | undefined, resource: CacheResource, mangaId: string, chapterId?: string): Promise<CachedPayloadPeek> {
    const providerId = getProviderId();
    const data = await fetchJson<unknown>(url, { signal });
    if (cacheStatus(data) === 'warming') {
        emit('cache-read', { providerId, resource, action: 'warming', mangaId, chapterId, count: 1 });
        return { status: 'warming' };
    }
    const updating = cacheUpdating(data);
    emit('cache-read', { providerId, resource, action: 'hit', mangaId, chapterId, count: 0, updating });
    return { status: 'hit', data, updating };
}

export function coverProxyUrl(mangaId: string, variant: 'card' | 'detail', sourceUrl?: string): string {
    let result = `/api/cache/manga/${encodeURIComponent(mangaId)}/cover/${variant}?${providerQueryParam()}`;
    if (sourceUrl) {
        const provider = getProvider();
        const params = new URLSearchParams({ source: sourceUrl, referer: provider.baseUrl });
        params.set('providerId', getProviderId());
        result = `/api/cache/manga/${encodeURIComponent(mangaId)}/cover/${variant}?${params}`;
    }
    return result;
}
export interface SearchResult {
    manga: Manga[];
    hasMore: boolean;
}

export interface MangaCardSnapshot {
    manga: Manga;
    chapters: ChapterMeta[] | null;
    mangaReady: boolean;
    chaptersReady: boolean;
}

export interface FavoritesBackupPayload {
    version: 1;
    savedAt: string;
    favorites: FavoriteBackupRow[];
}

interface RawMangaCardSnapshot {
    mangaId: string;
    manga: unknown | null;
    chapters: unknown | null;
    mangaReady: boolean;
    chaptersReady: boolean;
}

function rawCardSnapshots(data: unknown): RawMangaCardSnapshot[] {
    const root = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    const result = root.result && typeof root.result === 'object' ? root.result as Record<string, unknown> : {};
    const items = Array.isArray(result.items) ? result.items : [];
    return items
        .filter((item): item is Record<string, unknown> => item != null && typeof item === 'object')
        .map(item => ({
            mangaId: typeof item.mangaId === 'string' ? item.mangaId : '',
            manga: item.manga ?? null,
            chapters: item.chapters ?? null,
            mangaReady: item.mangaReady === true,
            chaptersReady: item.chaptersReady === true,
        }))
        .filter(item => item.mangaId.length > 0);
}

export async function searchManga(query: string, page = 1, filters?: SearchFilters, signal?: AbortSignal, retry = false, requestId?: string): Promise<SearchResult> {
    const provider = getProvider();
    const data = await fetchJson<unknown>('/api/search', {
        signal,
        retry,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: getProviderId(), query, page, filters, requestId }),
        timeoutMs: SEARCH_FETCH_TIMEOUT_MS,
    });
    const result = provider.parseSearchResponse(data);
    emit('search-result', {
        requestId,
        query: query || '(browse)',
        page,
        resultCount: result.items.length,
        hasMore: result.hasMore,
        includeGenres: filters?.includeGenres?.length ?? 0,
        excludeGenres: filters?.excludeGenres?.length ?? 0,
        demographics: filters?.demographics?.length ?? 0,
        authors: filters?.authors?.length ?? 0,
        artists: filters?.artists?.length ?? 0,
        types: filters?.types?.length ?? 0,
        statuses: filters?.statuses?.length ?? 0,
        ...(result.pagination ? {
            currentPage: result.pagination.currentPage,
            lastPage: result.pagination.lastPage,
            total: result.pagination.total,
        } : {}),
    });
    return { manga: result.items, hasMore: result.hasMore };
}

export async function fetchMangaCardSnapshots(
    fallbacks: Manga[],
    signal?: AbortSignal,
    includeChapters = false,
    providerId = getProviderId(),
    refresh: { enabled: boolean; reason: string } = { enabled: false, reason: 'card-snapshot-refresh' },
): Promise<MangaCardSnapshot[]> {
    if (fallbacks.length === 0) return [];
    const startedAt = performance.now();
    emit('manga-card-snapshots-request', { providerId, count: fallbacks.length, includeChapters });
    const provider = getProvider();
    const fallbackById = new Map(fallbacks.map(manga => [manga.id, manga]));
    const cardItems = fallbacks.map(manga => ({
        id: manga.id,
        title: manga.title,
        cover: manga.cover,
        latestChapter: manga.latestChapter ?? null,
    }));
    let data: unknown;
    try {
        data = await fetchJson<unknown>('/api/cache/manga/cards', {
            signal,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ providerId, items: cardItems, includeChapters, refresh: refresh.enabled, refreshReason: refresh.reason }),
        });
    } catch (e) {
        emit('manga-card-snapshots-error', {
            providerId,
            count: fallbacks.length,
            includeChapters,
            dtMs: Math.round(performance.now() - startedAt),
            error: String((e as Error)?.message ?? e),
        });
        throw e;
    }
    const raw = rawCardSnapshots(data);
    const snapshots = raw.map(snapshot => {
        const fallback = fallbackById.get(snapshot.mangaId) ?? {
            id: snapshot.mangaId,
            title: snapshot.mangaId,
            cover: '',
            latestChapter: null,
        };
        const detail = snapshot.manga ? provider.parseMangaDetailResponse?.(snapshot.manga) ?? {} : {};
        const manga = {
            ...fallback,
            ...detail,
            id: detail.id || fallback.id,
            title: detail.title || fallback.title,
            cover: detail.cover || fallback.cover,
            latestChapter: detail.latestChapter ?? fallback.latestChapter,
        };
        const chapters = snapshot.chapters ? provider.parseChapterListResponse(snapshot.chapters).items : null;
        if (chapters && chapters.length > 0) {
            const chapterMax = chapters.reduce((max, chapter) => Math.max(max, Number.isFinite(chapter.number) ? chapter.number : 0), 0);
            if (chapterMax > (manga.latestChapter ?? 0)) manga.latestChapter = chapterMax;
        }
        return {
            manga,
            chapters,
            mangaReady: snapshot.mangaReady,
            chaptersReady: snapshot.chaptersReady,
        };
    });
    emit('manga-card-snapshots-result', {
        providerId,
        count: fallbacks.length,
        includeChapters,
        resultCount: snapshots.length,
        mangaReady: raw.filter(item => item.mangaReady).length,
        chaptersReady: raw.filter(item => item.chaptersReady).length,
        dtMs: Math.round(performance.now() - startedAt),
    });
    return snapshots;
}

export async function saveFavoritesBackup(favorites: FavoriteBackupRow[]): Promise<FavoritesBackupPayload> {
    return fetchJson<FavoritesBackupPayload>('/api/favorites-backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, favorites }),
    });
}

export async function fetchFavoritesBackup(): Promise<FavoritesBackupPayload | null> {
    const res = await fetch('/api/favorites-backup', { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new ApiError(ApiErrKind.HTTP, res.status);
    return await res.json() as FavoritesBackupPayload;
}

export async function reconcileMangaCache(
    mangaId: string,
    observedLatestChapter: number,
    source: 'search-result' | 'manga-open',
    priority: CachePriority,
    signal?: AbortSignal,
): Promise<{
    status: string;
    cachedMax: number | null;
    observedLatestChapter: number | null;
    action: string;
    reason: string;
} | null> {
    const verbose = source !== 'search-result' || priority !== 'observed';
    if (verbose) emit('cache-reconcile-request', { mangaId, observedLatestChapter, source, priority });
    try {
        const result = await fetchJson<{
            status: string;
            cachedMax: number | null;
            observedLatestChapter: number | null;
            action: string;
            reason: string;
        }>(`/api/cache/manga/${encodeURIComponent(mangaId)}/reconcile`, {
            signal,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ providerId: getProviderId(), observedLatestChapter, source, priority }),
        });
        const freshNoopObserved = source === 'search-result' && priority === 'observed' && result.status === 'fresh' && result.action === 'none';
        if (!freshNoopObserved) {
            emit('cache-reconcile-result', {
                mangaId,
                observedLatestChapter: result.observedLatestChapter,
                cachedMax: result.cachedMax,
                source,
                priority,
                status: result.status,
                action: result.action,
                reason: result.reason,
            });
        }
        return result;
    } catch (e) {
        if (signal?.aborted) return null;
        emit('cache-reconcile-error', {
            mangaId,
            observedLatestChapter,
            source,
            priority,
            error: String((e as Error)?.message ?? e),
        });
        return null;
    }
}

function mergeMangaDetail(manga: Manga, raw: unknown): Manga {
    const provider = getProvider();
    const detail = provider.parseMangaDetailResponse?.(raw) ?? {};
    return {
        ...manga,
        ...detail,
        id: detail.id || manga.id,
        title: detail.title || manga.title,
        cover: detail.cover || manga.cover,
        latestChapter: detail.latestChapter ?? manga.latestChapter,
    };
}

function emitMangaDetailResult(merged: Manga): void {
    emit('manga-detail-result', {
        mangaId: merged.id,
        tags: merged.tags?.length ?? 0,
        genres: merged.genres?.length ?? 0,
        altTitles: merged.altTitles?.length ?? 0,
        recommendations: merged.recommendations?.length ?? 0,
        description: !!merged.description,
    });
}

export interface MangaDetailCacheResult {
    manga: Manga;
    attempts: number;
}

export interface ChapterListCacheResult {
    page: ChapterListPage;
    attempts: number;
    updating: boolean;
}

export interface MangaDetailCachePeek {
    status: 'hit' | 'warming';
    manga?: Manga;
}

export interface ChapterListCachePeek {
    status: 'hit' | 'warming';
    page?: ChapterListPage;
    updating?: boolean;
}

export async function peekMangaDetailCache(manga: Manga, signal?: AbortSignal): Promise<MangaDetailCachePeek> {
    const raw = await peekCachedPayload(`/api/cache/manga/${encodeURIComponent(manga.id)}?priority=interactive&${providerQueryParam()}`, signal, 'manga-detail', manga.id);
    if (raw.status === 'warming') return { status: 'warming' };
    const merged = mergeMangaDetail(manga, raw.data);
    emitMangaDetailResult(merged);
    return { status: 'hit', manga: merged };
}

export async function fetchMangaDetailWithCacheInfo(manga: Manga, signal?: AbortSignal): Promise<MangaDetailCacheResult> {
    try {
        const raw = await fetchCachedPayloadWithMeta(`/api/cache/manga/${encodeURIComponent(manga.id)}?priority=interactive&${providerQueryParam()}`, signal, 'manga-detail', manga.id, undefined, MANGA_DETAIL_CACHE_TIMEOUT_MS);
        const merged = mergeMangaDetail(manga, raw.data);
        emit('cache-read', { providerId: getProviderId(), resource: 'manga-detail', action: 'hit', mangaId: manga.id });
        emitMangaDetailResult(merged);
        return { manga: merged, attempts: raw.attempts };
    } catch (e) {
        if (!signal?.aborted) {
            emit('cache-read', { providerId: getProviderId(), resource: 'manga-detail', action: 'miss', mangaId: manga.id });
            emit('manga-detail-error', { mangaId: manga.id, error: String((e as Error)?.message ?? e) });
        }
        return { manga, attempts: CACHE_WARM_ATTEMPTS };
    }
}

export async function fetchMangaDetail(manga: Manga, signal?: AbortSignal): Promise<Manga> {
    return (await fetchMangaDetailWithCacheInfo(manga, signal)).manga;
}

export interface MangaCommentsResult {
    comments: MangaComment[];
    count: number;
    stats: MangaCommentStats;
}

function parseCommentsResult(data: unknown): MangaCommentsResult {
    const root = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    const result = root.result && typeof root.result === 'object' ? root.result as Record<string, unknown> : root;
    const comments = Array.isArray(result.comments) ? result.comments as MangaComment[] : [];
    const count = Number(result.count ?? comments.length);
    const rawStats = result.stats && typeof result.stats === 'object' ? result.stats as Record<string, unknown> : {};
    const stats = {
        total: Number(rawStats.total ?? comments.length),
        maxDepth: Number(rawStats.maxDepth ?? 0),
        parents: Number(rawStats.parents ?? 0),
        missingReplies: Number(rawStats.missingReplies ?? 0),
        rootPages: Number(rawStats.rootPages ?? result.pages ?? 1),
        replyPages: Number(rawStats.replyPages ?? 0),
        treeFills: Number(rawStats.treeFills ?? 0),
        unavailable: Number(rawStats.unavailable ?? 0),
        unavailableRoots: Number(rawStats.unavailableRoots ?? 0),
    };
    return {
        comments,
        count: Number.isFinite(count) ? count : comments.length,
        stats: {
            total: Number.isFinite(stats.total) ? stats.total : comments.length,
            maxDepth: Number.isFinite(stats.maxDepth) ? stats.maxDepth : 0,
            parents: Number.isFinite(stats.parents) ? stats.parents : 0,
            missingReplies: Number.isFinite(stats.missingReplies) ? stats.missingReplies : 0,
            rootPages: Number.isFinite(stats.rootPages) ? stats.rootPages : 1,
            replyPages: Number.isFinite(stats.replyPages) ? stats.replyPages : 0,
            treeFills: Number.isFinite(stats.treeFills) ? stats.treeFills : 0,
            unavailable: Number.isFinite(stats.unavailable) ? stats.unavailable : 0,
            unavailableRoots: Number.isFinite(stats.unavailableRoots) ? stats.unavailableRoots : 0,
        },
    };
}

export async function fetchMangaComments(mangaId: string, signal?: AbortSignal): Promise<MangaCommentsResult> {
    const params = new URLSearchParams({ _: String(Date.now()), providerId: getProviderId() });
    const data = await fetchJson<unknown>(`/api/manga-comments/${encodeURIComponent(mangaId)}?${params}`, {
        signal,
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' },
        timeoutMs: COMMENTS_FETCH_TIMEOUT_MS,
    });
    const parsed = parseCommentsResult(data);
    emit('manga-comments-result', {
        mangaId,
        rootPages: parsed.stats.rootPages,
        replyPages: parsed.stats.replyPages,
        treeFills: parsed.stats.treeFills,
        top: parsed.comments.length,
        total: parsed.stats.total,
        maxDepth: parsed.stats.maxDepth,
        missingReplies: parsed.stats.missingReplies,
        unavailable: parsed.stats.unavailable,
        unavailableRoots: parsed.stats.unavailableRoots,
        count: parsed.count,
    });
    return parsed;
}

export async function fetchChapterComments(mangaId: string, chapter: ChapterMeta, signal?: AbortSignal): Promise<MangaCommentsResult> {
    const params = new URLSearchParams({ number: String(chapter.number), providerId: getProviderId() });
    if (chapter.url) params.set('url', chapter.url);
    params.set('_', String(Date.now()));
    const data = await fetchJson<unknown>(`/api/chapter-comments/${encodeURIComponent(mangaId)}/${encodeURIComponent(chapter.id)}?${params}`, {
        signal,
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' },
        timeoutMs: COMMENTS_FETCH_TIMEOUT_MS,
    });
    const parsed = parseCommentsResult(data);
    emit('chapter-comments-result', {
        mangaId,
        chapterId: chapter.id,
        chapterNumber: chapter.number,
        rootPages: parsed.stats.rootPages,
        replyPages: parsed.stats.replyPages,
        treeFills: parsed.stats.treeFills,
        top: parsed.comments.length,
        total: parsed.stats.total,
        maxDepth: parsed.stats.maxDepth,
        missingReplies: parsed.stats.missingReplies,
        unavailable: parsed.stats.unavailable,
        unavailableRoots: parsed.stats.unavailableRoots,
        count: parsed.count,
    });
    return parsed;
}

async function fetchCachedChapterListPage(mangaId: string, signal?: AbortSignal): Promise<ChapterListPage> {
    return (await fetchChapterListWithCacheInfo(mangaId, signal)).page;
}

export async function peekChapterListCache(mangaId: string, signal?: AbortSignal): Promise<ChapterListCachePeek> {
    const provider = getProvider();
    const raw = await peekCachedPayload(`/api/cache/manga/${encodeURIComponent(mangaId)}/chapters?priority=interactive&${providerQueryParam()}`, signal, 'chapter-list', mangaId);
    if (raw.status === 'warming') return { status: 'warming' };
    return { status: 'hit', page: provider.parseChapterListResponse(raw.data), updating: raw.updating === true };
}

export async function fetchChapterListWithCacheInfo(mangaId: string, signal?: AbortSignal): Promise<ChapterListCacheResult> {
    const provider = getProvider();
    const raw = await fetchCachedPayloadWithMeta(`/api/cache/manga/${encodeURIComponent(mangaId)}/chapters?priority=interactive&${providerQueryParam()}`, signal, 'chapter-list', mangaId);
    return { page: provider.parseChapterListResponse(raw.data), attempts: raw.attempts, updating: raw.updating };
}

export async function* fetchChapterList(
    mangaId: string,
    signal?: AbortSignal,
): AsyncGenerator<ChapterListPage> {
    yield await fetchCachedChapterListPage(mangaId, signal);
}

export async function fetchChapterListPage(mangaId: string, page: number, signal?: AbortSignal): Promise<ChapterListPage> {
    void page;
    return fetchCachedChapterListPage(mangaId, signal);
}

async function fetchCachedChapterImages(mangaId: string, chapterId: string, chapterNumber: number, chapterUrl?: string): Promise<ChapterPage[]> {
    const provider = getProvider();
    const params = new URLSearchParams({ number: String(chapterNumber), priority: 'interactive', providerId: getProviderId() });
    if (chapterUrl) params.set('url', chapterUrl);
    const data = await fetchCachedPayload(
        `/api/cache/manga/${encodeURIComponent(mangaId)}/chapters/${encodeURIComponent(chapterId)}/images?${params}`,
        undefined,
        'chapter-images',
        mangaId,
        chapterId,
        CHAPTER_IMAGE_CACHE_TIMEOUT_MS,
    );
    const pages = provider.parseChapterImagesResponse(data);
    emit('chapter-images-result', {
        providerId: getProviderId(),
        mangaId,
        chapterId,
        chapterNumber,
        imageCount: pages.length,
        scrambled: pages.filter(page => page.scramble).length,
    });
    if (pages.length === 0) {
        throw new Error(`Cache returned no pages for chapter ${mangaId}/${chapterId}`);
    }
    return pages;
}

export async function fetchChapterImages(mangaId: string, chapterId: string, chapterNumber: number, chapterUrl?: string): Promise<ChapterPage[]> {
    return fetchCachedChapterImages(mangaId, chapterId, chapterNumber, chapterUrl);
}
