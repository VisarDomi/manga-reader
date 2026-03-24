import { PROXY_URL, imageProxyUrl as _imageProxyUrl } from '../config.js';
import { fetchJson, fetchRaw, ApiError, ApiErrKind } from './fetchJson.js';
import { getProvider } from './provider.js';
import type { Manga, ChapterMeta, ChapterPage } from '../types.js';
import type { SearchFilters, HttpRequest, PaginationMeta, ChapterListPage } from '@manga-reader/provider-types';
import type { LogFn } from './LogService.js';

export { ApiError, ApiErrKind } from './fetchJson.js';

// --- Log function (owned by AppState, injected once at init) ---

let log: LogFn = () => {};

export function setApiLogger(fn: LogFn): void {
    log = fn;
}

// --- Cloudflare callback ---

let onCloudflare: (() => void) | null = null;

export function setCloudflareCallback(cb: () => void): void {
    onCloudflare = cb;
}

// --- Proxy helper ---

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

            // Retry loop: wait 5s, retry, up to 6 attempts (30s total)
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

// --- Image proxy URL ---

export function imageProxyUrl(url: string): string {
    const provider = getProvider();
    const referer = provider.imageHeaders?.()?.['Referer'];
    return _imageProxyUrl(url, referer);
}

// --- Search ---

export interface SearchResult {
    manga: Manga[];
    hasMore: boolean;
}

export async function searchManga(query: string, page = 1, filters?: SearchFilters, signal?: AbortSignal, retry = false): Promise<SearchResult> {
    const provider = getProvider();
    const req = provider.searchRequest(query, page, filters);
    const data = await proxyRequest(req, 'json', { signal, retry });
    const result = provider.parseSearchResponse(data);
    log('search-result', {
        query: query || '(browse)',
        page,
        resultCount: result.items.length,
        hasMore: result.hasMore,
        ...(result.pagination ? {
            currentPage: result.pagination.currentPage,
            lastPage: result.pagination.lastPage,
            total: result.pagination.total,
        } : {}),
    });
    return { manga: result.items, hasMore: result.hasMore };
}

// --- Chapters ---

/**
 * Async generator that yields chapter pages as they arrive.
 *
 * Phase 1: Fetch page 1 sequentially — establishes pagination bounds.
 * Phase 2: Fetch pages 2..lastPage in parallel — yield each as it completes.
 *
 * Consumer owns dedup. Generator owns fetch lifecycle and logging.
 * Partial results on failure: if some pages fail, successful pages still yield.
 * Page 1 failure propagates — nothing to show without it.
 */
export async function* fetchChapterList(
    mangaId: string,
    signal?: AbortSignal,
): AsyncGenerator<ChapterListPage> {
    const provider = getProvider();

    // Phase 1: page 1 — sequential, establishes pagination bounds
    const req1 = provider.chapterListRequest(mangaId, 1);
    const data1 = await proxyRequest(req1, 'json', { signal });
    const page1 = provider.parseChapterListResponse(data1);
    log('chapters-page', {
        mangaId, page: 1,
        items: page1.items.length,
        lastPage: page1.pagination.lastPage,
        total: page1.pagination.total,
    });
    yield page1;

    const { lastPage, total } = page1.pagination;
    if (lastPage <= 1) {
        log('chapters-done', { mangaId, pages: 1, total });
        return;
    }

    // Phase 2: pages 2..lastPage — parallel, yield as each completes
    const remaining = lastPage - 1;
    log('chapters-parallel', { mangaId, remaining, total });

    // Channel: settled results waiting to be yielded
    const settled: (ChapterListPage | null)[] = [];
    let notify: (() => void) | null = null;
    let pending = remaining;
    let failed = 0;

    for (let page = 2; page <= lastPage; page++) {
        const req = provider.chapterListRequest(mangaId, page);
        proxyRequest(req, 'json', { signal })
            .then(data => {
                const parsed = provider.parseChapterListResponse(data);
                log('chapters-page', { mangaId, page, items: parsed.items.length });
                settled.push(parsed);
            })
            .catch(e => {
                if (!signal?.aborted) {
                    log('chapters-page-error', { mangaId, page, error: String((e as Error)?.message ?? e) });
                }
                failed++;
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

    log('chapters-done', { mangaId, pages: lastPage, failed, total });
}

// --- Chapter Images ---

export async function fetchChapterImages(mangaId: string, chapterId: string, chapterNumber: number): Promise<ChapterPage[]> {
    const provider = getProvider();
    const req = provider.chapterImagesRequest(mangaId, chapterId, chapterNumber);
    const responseType = provider.chapterImagesResponseType === 'html' ? 'text' : 'json';
    const data = await proxyRequest(req, responseType as 'json' | 'text', { retry: true });
    const pages = provider.parseChapterImagesResponse(data);
    log('chapter-images-result', { mangaId, chapterId, chapterNumber, imageCount: pages.length });
    return pages;
}
