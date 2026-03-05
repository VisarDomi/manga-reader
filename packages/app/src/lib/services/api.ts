import { PROXY_URL, imageProxyUrl as _imageProxyUrl } from '../config.js';
import { fetchJson, fetchRaw, ApiError } from './fetchJson.js';
import { getProvider } from './provider.js';
import type { Manga, ChapterMeta, ChapterPage } from '../types.js';
import type { SearchFilters, HttpRequest } from '@manga-reader/provider-types';

export { ApiError } from './fetchJson.js';

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
        if (e instanceof ApiError && e.kind === 'cloudflare') {
            onCloudflare?.();

            // Retry loop: wait 5s, retry, up to 6 attempts (30s total)
            for (let attempt = 0; attempt < 6; attempt++) {
                await new Promise(r => setTimeout(r, 5000));
                if (opts.signal?.aborted) throw e;
                try {
                    return await doRequest();
                } catch (retryErr) {
                    if (retryErr instanceof ApiError && retryErr.kind === 'cloudflare') {
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
    return { manga: result.items, hasMore: result.hasMore };
}

// --- Chapters ---

export async function fetchChapterList(mangaId: string, signal?: AbortSignal): Promise<ChapterMeta[]> {
    const provider = getProvider();
    // Fetch pages 1-5 in parallel (100 per page = 500 max chapters)
    const pages = [1, 2, 3, 4, 5];
    const results = await Promise.all(
        pages.map(page => {
            const req = provider.chapterListRequest(mangaId, page);
            return proxyRequest(req, 'json', { signal })
                .catch((e) => {
                    if (signal?.aborted) throw e;
                    return null;
                });
        })
    );

    const allItems: ChapterMeta[] = [];
    const seen = new Set<string>();

    for (const data of results) {
        if (!data) continue;
        const chapters = provider.parseChapterListResponse(data);
        for (const ch of chapters) {
            if (seen.has(ch.id)) continue;
            seen.add(ch.id);
            allItems.push(ch);
        }
    }

    return allItems;
}

// --- Chapter Images ---

export async function fetchChapterImages(mangaId: string, chapterId: string, chapterNumber: number): Promise<ChapterPage[]> {
    const provider = getProvider();
    const req = provider.chapterImagesRequest(mangaId, chapterId, chapterNumber);
    const responseType = provider.chapterImagesResponseType === 'html' ? 'text' : 'json';
    const data = await proxyRequest(req, responseType as 'json' | 'text', { retry: true });
    return provider.parseChapterImagesResponse(data);
}
