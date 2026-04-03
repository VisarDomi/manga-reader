import { PROXY_URL, imageProxyUrl as _imageProxyUrl } from '../config.js';
import { fetchJson, fetchRaw, ApiError, ApiErrKind } from './fetchJson.js';
import { getProvider } from './provider.js';
import type { Manga, ChapterMeta, ChapterPage } from '../types.js';
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
export function imageProxyUrl(url: string, mangaId: string, chapterId: string, chapterNumber: number): string {
    const provider = getProvider();
    const referer = provider.imageHeaders?.(mangaId, chapterId, chapterNumber)?.['Referer'];
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
        ...(result.pagination ? {
            currentPage: result.pagination.currentPage,
            lastPage: result.pagination.lastPage,
            total: result.pagination.total,
        } : {}),
    });
    return { manga: result.items, hasMore: result.hasMore };
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
export async function fetchChapterImages(mangaId: string, chapterId: string, chapterNumber: number): Promise<ChapterPage[]> {
    const provider = getProvider();
    const req = provider.chapterImagesRequest(mangaId, chapterId, chapterNumber);
    const responseType = provider.chapterImagesResponseType === 'html' ? 'text' : 'json';
    const data = await proxyRequest(req, responseType as 'json' | 'text', { retry: true });
    const pages = provider.parseChapterImagesResponse(data);
    emit('chapter-images-result', { mangaId, chapterId, chapterNumber, imageCount: pages.length });
    return pages;
}
