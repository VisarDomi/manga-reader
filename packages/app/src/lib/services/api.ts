import { PROXY_URL, imageProxyUrl as _imageProxyUrl } from '../config.js';
import { fetchJson, fetchRaw, ApiError, ApiErrKind } from './fetchJson.js';
import { getProvider } from './provider.js';
import type { Manga, ChapterMeta, ChapterPage, MangaComment, MangaCommentStats } from '../types.js';
import type { SearchFilters, HttpRequest, PaginationMeta, ChapterListPage } from '@manga-reader/provider-types';
import type { LogEmit } from './LogService.js';

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
    const provider = getProvider();
    if (!provider.parseMangaDetailResponse) {
        emit('manga-detail-result', { mangaId: manga.id, tags: manga.tags?.length ?? 0, genres: manga.genres?.length ?? 0, altTitles: manga.altTitles?.length ?? 0, recommendations: manga.recommendations?.length ?? 0, description: !!manga.description });
        return manga;
    }

    try {
        const data = await fetchJson<unknown>(`/api/manga-detail/${encodeURIComponent(manga.id)}`, { signal });
        const detail = provider.parseMangaDetailResponse(data);
        const merged = {
            ...manga,
            ...detail,
            id: detail.id || manga.id,
            title: detail.title || manga.title,
            cover: detail.cover || manga.cover,
            latestChapter: detail.latestChapter ?? manga.latestChapter,
        };
        emit('manga-detail-result', {
            mangaId: merged.id,
            tags: merged.tags?.length ?? 0,
            genres: merged.genres?.length ?? 0,
            altTitles: merged.altTitles?.length ?? 0,
            recommendations: merged.recommendations?.length ?? 0,
            description: !!merged.description,
        });
        return merged;
    } catch (e) {
        if (!signal?.aborted) {
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

export async function* fetchChapterList(
    mangaId: string,
    signal?: AbortSignal,
): AsyncGenerator<ChapterListPage> {
    const provider = getProvider();

    const req1 = provider.chapterListRequest(mangaId, 1);
    const data1 = await proxyRequest(req1, 'json', { signal });
    const page1 = provider.parseChapterListResponse(data1);
    yield page1;

    const { lastPage, total } = page1.pagination;
    if (lastPage <= 1) {
        return;
    }

    const remaining = lastPage - 1;
    emit('chapters-parallel', { mangaId, remaining, total });

    const settled: (ChapterListPage | null)[] = [];
    let notify: (() => void) | null = null;
    let pending = remaining;

    for (let page = 2; page <= lastPage; page++) {
        const req = provider.chapterListRequest(mangaId, page);
        proxyRequest(req, 'json', { signal })
            .then(data => {
                const parsed = provider.parseChapterListResponse(data);
                settled.push(parsed);
            })
            .catch(e => {
                if (!signal?.aborted) {
                    emit('chapters-page-error', { mangaId, page, error: String((e as Error)?.message ?? e) });
                }
                settled.push(null);
            })
            .finally(() => {
                pending--;
                notify?.();
            });
    }

    while (pending > 0 || settled.length > 0) {
        if (signal?.aborted) return;
        if (settled.length > 0) {
            const batch = settled.shift()!;
            if (batch) yield batch;
        } else {
            await new Promise<void>(r => {
                notify = r;
                signal?.addEventListener('abort', () => r(), { once: true });
            });
            notify = null;
        }
    }

}
export function prewarmChapters(mangaIds: string[]): void {
    if (mangaIds.length === 0) return;
    emit('prewarm-sent', { count: mangaIds.length });
    fetch('/api/prewarm-chapters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mangaIds }),
    }).catch(() => {});
}

export function prewarmChapterDetails(mangaId: string, chapters: ChapterMeta[]): void {
    if (chapters.length === 0) return;
    const provider = getProvider();
    const requests = chapters
        .map(chapter => {
            const req = provider.chapterImagesRequest(mangaId, chapter.id, chapter.number, chapter.url);
            if (!req.signingMangaId || !req.signingPageUrl) return null;
            return {
                mangaId: req.signingMangaId,
                chapterId: chapter.id,
                signingPageUrl: req.signingPageUrl,
            };
        })
        .filter((req): req is { mangaId: string; chapterId: string; signingPageUrl: string } => req != null);

    if (requests.length === 0) return;
    emit('chapter-warmup-sent', { count: requests.length });
    fetch('/api/prewarm-chapter-details', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }),
    }).catch(() => {});
}

export async function fetchChapterImages(mangaId: string, chapterId: string, chapterNumber: number, chapterUrl?: string): Promise<ChapterPage[]> {
    const provider = getProvider();
    const req = provider.chapterImagesRequest(mangaId, chapterId, chapterNumber, chapterUrl);
    const responseType = provider.chapterImagesResponseType === 'html' ? 'text' : 'json';
    const data = await proxyRequest(req, responseType as 'json' | 'text', { retry: true });
    const pages = provider.parseChapterImagesResponse(data);
    emit('chapter-images-result', { mangaId, chapterId, chapterNumber, imageCount: pages.length });
    return pages;
}
