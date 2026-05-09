import { PROXY_URL, imageProxyUrl as _imageProxyUrl } from '../config.js';
import { fetchJson, fetchRaw, ApiError, ApiErrKind } from './fetchJson.js';
import { getProvider } from './provider.js';
import type { Manga, ChapterMeta, ChapterPage, MangaComment, MangaCommentStats } from '../types.js';
import type { SearchFilters, HttpRequest, PaginationMeta, ChapterListPage } from '@manga-reader/provider-types';
import type { LogEmit } from './LogService.js';
import { CACHE_ONLY_MODE } from '../constants.js';

export { ApiError, ApiErrKind } from './fetchJson.js';
let emit: LogEmit = (() => {}) as unknown as LogEmit;

export function setApiLogger(fn: LogEmit): void {
    emit = fn;
}

let onCloudflare: (() => void) | null = null;

export function setCloudflareCallback(cb: () => void): void {
    onCloudflare = cb;
}
interface ProxyOptions {
    signal?: AbortSignal;
    retry?: boolean;
}

const CACHE_WARM_POLL_MS = 500;
const CACHE_WARM_ATTEMPTS = 240;

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

async function fetchCachedPayload(url: string, signal: AbortSignal | undefined, resource: 'chapter-list' | 'chapter-images', mangaId: string, chapterId?: string): Promise<unknown> {
    for (let attempt = 0; attempt < CACHE_WARM_ATTEMPTS; attempt++) {
        const data = await fetchJson<unknown>(url, { signal });
        if (cacheStatus(data) !== 'warming') {
            emit('cache-only-read', { resource, action: 'hit', mangaId, chapterId, count: attempt });
            return data;
        }
        emit('cache-only-read', { resource, action: 'warming', mangaId, chapterId, count: attempt + 1 });
        await sleep(CACHE_WARM_POLL_MS, signal);
    }
    emit('cache-only-read', { resource, action: 'miss', mangaId, chapterId, count: CACHE_WARM_ATTEMPTS });
    throw new Error(`Cache warming timed out for ${resource}`);
}

async function proxyRequest<T>(req: HttpRequest, responseType: 'json' | 'text', opts: ProxyOptions = {}): Promise<T> {
    const body = JSON.stringify({
        url: req.url,
        method: req.method ?? 'GET',
        headers: req.headers,
        body: req.body,
        responseType,
        cloudflareProtected: req.cloudflareProtected,
        signingMangaId: req.signingMangaId,
        signingPageUrl: req.signingPageUrl,
    });

    const fetchOpts = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: opts.signal,
        retry: opts.retry,
    };

    const doRequest = () => {
        if (responseType === 'text') {
            return fetchRaw(PROXY_URL, fetchOpts) as Promise<T>;
        }
        return fetchJson<T>(PROXY_URL, fetchOpts);
    };

    try {
        return await doRequest();
    } catch (e) {
        if (e instanceof ApiError && e.kind === ApiErrKind.CLOUDFLARE) {
            onCloudflare?.();

            for (let attempt = 0; attempt < 6; attempt++) {
                await new Promise(r => setTimeout(r, 5000));
                if (opts.signal?.aborted) throw e;
                try {
                    return await doRequest();
                } catch (retryErr) {
                    if (retryErr instanceof ApiError && retryErr.kind === ApiErrKind.CLOUDFLARE) {
                        continue;
                    }
                    throw retryErr;
                }
            }
            throw e;
        }
        throw e;
    }
}
export function imageProxyUrl(url: string, mangaId: string, chapterId: string, chapterNumber: number, chapterUrl?: string): string {
    const provider = getProvider();
    const referer = provider.imageHeaders?.(mangaId, chapterId, chapterNumber, chapterUrl)?.['Referer'];
    return _imageProxyUrl(url, referer);
}

export function coverProxyUrl(url: string): string {
    const provider = getProvider();
    return _imageProxyUrl(url, provider.baseUrl);
}
export interface SearchResult {
    manga: Manga[];
    hasMore: boolean;
}

export async function searchManga(query: string, page = 1, filters?: SearchFilters, signal?: AbortSignal, retry = false): Promise<SearchResult> {
    if (CACHE_ONLY_MODE) {
        void signal;
        void retry;
        emit('cache-only-read', { resource: 'search', action: 'skip', mangaId: 'search', count: page });
        return { manga: [], hasMore: false };
    }

    const provider = getProvider();
    const req = provider.searchRequest(query, page, filters);
    const data = await proxyRequest(req, 'json', { signal, retry });
    const result = provider.parseSearchResponse(data);
    emit('search-result', {
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

export async function fetchMangaDetail(manga: Manga, signal?: AbortSignal): Promise<Manga> {
    void signal;
    emit('cache-only-read', { resource: 'manga-detail', action: 'skip', mangaId: manga.id });
    return manga;
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
    if (CACHE_ONLY_MODE) {
        emit('cache-only-read', { resource: 'manga-comments', action: 'skip', mangaId });
        return { comments: [], count: 0, stats: { total: 0, maxDepth: 0, parents: 0, missingReplies: 0, rootPages: 0, replyPages: 0, treeFills: 0, unavailable: 0, unavailableRoots: 0 } };
    }

    const data = await fetchJson<unknown>(`/api/manga-comments/${encodeURIComponent(mangaId)}`, { signal });
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
    if (CACHE_ONLY_MODE) {
        emit('cache-only-read', { resource: 'chapter-comments', action: 'skip', mangaId, chapterId: chapter.id });
        return { comments: [], count: 0, stats: { total: 0, maxDepth: 0, parents: 0, missingReplies: 0, rootPages: 0, replyPages: 0, treeFills: 0, unavailable: 0, unavailableRoots: 0 } };
    }

    const params = new URLSearchParams({ number: String(chapter.number) });
    if (chapter.url) params.set('url', chapter.url);
    const data = await fetchJson<unknown>(`/api/chapter-comments/${encodeURIComponent(mangaId)}/${encodeURIComponent(chapter.id)}?${params}`, { signal });
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
    const provider = getProvider();
    const data = await fetchCachedPayload(`/api/cache/manga/${encodeURIComponent(mangaId)}/chapters`, signal, 'chapter-list', mangaId);
    return provider.parseChapterListResponse(data);
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

export async function refreshMangaCache(mangaId: string): Promise<void> {
    await fetchJson(`/api/cache/manga/${encodeURIComponent(mangaId)}/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
    });
    await fetchCachedPayload(`/api/cache/manga/${encodeURIComponent(mangaId)}/chapters`, undefined, 'chapter-list', mangaId);
}

async function fetchCachedChapterImages(mangaId: string, chapterId: string, chapterNumber: number, chapterUrl?: string): Promise<ChapterPage[]> {
    const provider = getProvider();
    const params = new URLSearchParams({ number: String(chapterNumber) });
    if (chapterUrl) params.set('url', chapterUrl);
    const data = await fetchCachedPayload(
        `/api/cache/manga/${encodeURIComponent(mangaId)}/chapters/${encodeURIComponent(chapterId)}/images?${params}`,
        undefined,
        'chapter-images',
        mangaId,
        chapterId,
    );
    const pages = provider.parseChapterImagesResponse(data);
    emit('chapter-images-result', { mangaId, chapterId, chapterNumber, imageCount: pages.length });
    if (pages.length === 0) {
        throw new Error(`Cache returned no pages for chapter ${mangaId}/${chapterId}`);
    }
    return pages;
}

export async function fetchChapterImages(mangaId: string, chapterId: string, chapterNumber: number, chapterUrl?: string): Promise<ChapterPage[]> {
    return fetchCachedChapterImages(mangaId, chapterId, chapterNumber, chapterUrl);
}
