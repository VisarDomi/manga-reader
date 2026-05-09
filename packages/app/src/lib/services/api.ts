import { imageProxyUrl as _imageProxyUrl } from '../config.js';
import { fetchJson, ApiError, ApiErrKind } from './fetchJson.js';
import { getProvider } from './provider.js';
import type { Manga, ChapterMeta, ChapterPage, MangaComment, MangaCommentStats } from '../types.js';
import type { SearchFilters, ChapterListPage } from '@manga-reader/provider-types';
import type { LogEmit } from './LogService.js';
import { CACHE_ONLY_MODE } from '../constants.js';

export { ApiError, ApiErrKind } from './fetchJson.js';
let emit: LogEmit = (() => {}) as unknown as LogEmit;

export function setApiLogger(fn: LogEmit): void {
    emit = fn;
}

export function setCloudflareCallback(cb: () => void): void {
    void cb;
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

async function fetchCachedPayload(url: string, signal: AbortSignal | undefined, resource: 'manga-detail' | 'chapter-list' | 'chapter-images', mangaId: string, chapterId?: string): Promise<unknown> {
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
    void query;
    void filters;
    void signal;
    void retry;
    void CACHE_ONLY_MODE;
    emit('cache-only-read', { resource: 'search', action: 'skip', mangaId: 'search', count: page });
    return { manga: [], hasMore: false };
}

export async function fetchMangaDetail(manga: Manga, signal?: AbortSignal): Promise<Manga> {
    const provider = getProvider();
    try {
        const raw = await fetchCachedPayload(`/api/cache/manga/${encodeURIComponent(manga.id)}`, signal, 'manga-detail', manga.id);
        const detail = provider.parseMangaDetailResponse?.(raw) ?? {};
        const merged = {
            ...manga,
            ...detail,
            id: detail.id || manga.id,
            title: detail.title || manga.title,
            cover: detail.cover || manga.cover,
            latestChapter: detail.latestChapter ?? manga.latestChapter,
            recommendations: [],
        };
        emit('cache-only-read', { resource: 'manga-detail', action: 'hit', mangaId: manga.id });
        emit('manga-detail-result', {
            mangaId: merged.id,
            tags: merged.tags?.length ?? 0,
            genres: merged.genres?.length ?? 0,
            altTitles: merged.altTitles?.length ?? 0,
            recommendations: 0,
            description: !!merged.description,
        });
        return merged;
    } catch (e) {
        if (!signal?.aborted) {
            emit('cache-only-read', { resource: 'manga-detail', action: 'miss', mangaId: manga.id });
            emit('manga-detail-error', { mangaId: manga.id, error: String((e as Error)?.message ?? e) });
        }
        return manga;
    }
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
