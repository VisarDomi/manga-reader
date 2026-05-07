import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { proxyFetchJson, proxyFetchText } from '../utils/proxyFetch.js';
import type { BrowserSession } from '../services/BrowserSession.js';
import type { ProxyFetchMeta } from '../utils/proxyFetch.js';

interface ProxyBody {
    url: string;
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    responseType?: 'json' | 'text';
    cloudflareProtected?: boolean;
    signingMangaId?: string;
    signingPageUrl?: string;
}

interface PrewarmChapterDetailRequest {
    mangaId: string;
    chapterId: string;
    signingPageUrl: string;
}

function jsonApiStatus(data: unknown): string {
    if (!data || typeof data !== 'object') return 'none';
    const status = (data as Record<string, unknown>).status;
    return status == null ? 'none' : String(status);
}

function jsonResultSummary(data: unknown): string {
    if (!data || typeof data !== 'object') return `type=${typeof data}`;
    const result = (data as Record<string, unknown>).result;
    if (!result || typeof result !== 'object') return `result=${result === null ? 'null' : typeof result}`;
    const items = (result as Record<string, unknown>).items;
    if (Array.isArray(items)) return `items=${items.length}`;
    const pages = (result as Record<string, unknown>).pages;
    if (Array.isArray(pages)) return `pages=${pages.length}`;
    return 'items=none';
}

function detailSummary(data: unknown): string {
    if (!data || typeof data !== 'object') return `type=${typeof data}`;
    const result = (data as Record<string, unknown>).result;
    if (!result || typeof result !== 'object') return `result=${result === null ? 'null' : typeof result}`;
    const r = result as Record<string, unknown>;
    const tags = Array.isArray(r.tags) ? r.tags.length : 0;
    const genres = Array.isArray(r.genres) ? r.genres.length : 0;
    const demographics = Array.isArray(r.demographics) ? r.demographics.length : 0;
    const altTitles = Array.isArray(r.altTitles) ? r.altTitles.length : Array.isArray(r.alt_titles) ? r.alt_titles.length : 0;
    const recommendations = Array.isArray(r.recommendations) ? r.recommendations.length : 0;
    const description = Boolean(r.synopsis || r.description);
    return `title=${typeof r.title === 'string' && r.title.length > 0 ? 'yes' : 'no'} genres=${genres} tags=${tags} demographics=${demographics} altTitles=${altTitles} recommendations=${recommendations} description=${description}`;
}

function commentsSummary(data: unknown): string {
    if (!data || typeof data !== 'object') return `type=${typeof data}`;
    const result = (data as Record<string, unknown>).result;
    if (!result || typeof result !== 'object') return `result=${result === null ? 'null' : typeof result}`;
    const r = result as Record<string, unknown>;
    const comments = Array.isArray(r.comments) ? r.comments.length : 0;
    const count = Number(r.count ?? comments);
    const thread = r.thread && typeof r.thread === 'object' ? (r.thread as Record<string, unknown>).id : null;
    return `thread=${thread == null ? 'none' : thread} comments=${comments} count=${Number.isFinite(count) ? count : comments}`;
}

function logJsonProxy(method: string, pathStr: string, meta: ProxyFetchMeta, data: unknown): void {
    console.log(`[proxy] ${method} ${pathStr} http=${meta.status} api=${jsonApiStatus(data)} ${jsonResultSummary(data)} ${meta.durationMs}ms`);
}

export function createProxyRouter(browserSession: BrowserSession | null): Router {
    const router = Router();

    router.get('/manga-detail/:mangaId', asyncHandler(async (req, res) => {
        const rawMangaId = req.params.mangaId;
        const mangaId = typeof rawMangaId === 'string' ? rawMangaId : undefined;
        if (!mangaId) {
            res.status(400).json({ error: 'Missing mangaId' });
            return;
        }

        if (!browserSession?.ready) {
            res.status(503).json({ error: 'BrowserSession not ready' });
            return;
        }

        const result = await browserSession.fetchMangaDetail(mangaId);
        console.log(`[proxy] manga-detail ${mangaId} api=${jsonApiStatus(result.data)} ${detailSummary(result.data)} ${result.durationMs}ms`);
        res.json(result.data);
    }));

    router.get('/manga-comments/:mangaId', asyncHandler(async (req, res) => {
        const rawMangaId = req.params.mangaId;
        const mangaId = typeof rawMangaId === 'string' ? rawMangaId : undefined;
        if (!mangaId) {
            res.status(400).json({ error: 'Missing mangaId' });
            return;
        }

        if (!browserSession?.ready) {
            res.status(503).json({ error: 'BrowserSession not ready' });
            return;
        }

        const result = await browserSession.fetchMangaComments(mangaId);
        console.log(`[proxy] manga-comments ${mangaId} api=${jsonApiStatus(result.data)} ${commentsSummary(result.data)} ${result.durationMs}ms`);
        res.json(result.data);
    }));

    router.post('/proxy', asyncHandler(async (req, res) => {
        const { url, method = 'GET', headers = {}, body, responseType = 'json', cloudflareProtected, signingMangaId, signingPageUrl } = req.body as ProxyBody;

        if (!url || typeof url !== 'string') {
            res.status(400).json({ error: 'Missing or invalid url', status: 400 });
            return;
        }

        try {
            new URL(url);
        } catch {
            res.status(400).json({ error: 'Invalid URL', status: 400 });
            return;
        }

        const parsed = new URL(url);
        const pathStr = parsed.pathname + (parsed.search ? parsed.search : '');

        if (browserSession?.needsSigning(url, signingMangaId)) {
            const result = await browserSession.signedFetch(url, signingMangaId, signingPageUrl);
            console.log(`[proxy] signed ${pathStr} api=${jsonApiStatus(result.data)} ${jsonResultSummary(result.data)} ${result.durationMs}ms`);
            res.json(result.data);
            return;
        }

        if (!browserSession && /\/manga\/[^/]+\/chapters/.test(url)) {
            res.status(503).json({ error: 'Chapter requests require BrowserSession signing', status: 503 });
            return;
        }

        const fetchOpts = {
            method,
            headers: {
                'User-Agent': req.headers['user-agent'] || '',
                ...headers,
            },
            body: body ?? undefined,
            cloudflareProtected,
        };

        if (responseType === 'text') {
            const { data, meta } = await proxyFetchText(url, fetchOpts);
            console.log(`[proxy] ${method} ${pathStr} http=${meta.status} ${meta.durationMs}ms`);
            res.set('Content-Type', 'text/plain; charset=utf-8');
            res.send(data);
        } else {
            const { data, meta } = await proxyFetchJson(url, fetchOpts);
            logJsonProxy(method, pathStr, meta, data);
            res.json(data);
        }
    }));

    router.post('/prewarm-chapters', asyncHandler(async (req, res) => {
        const { mangaIds } = req.body as { mangaIds?: string[] };

        if (!Array.isArray(mangaIds) || mangaIds.length === 0) {
            res.status(400).json({ error: 'Missing mangaIds array' });
            return;
        }

        if (!browserSession?.ready) {
            res.status(503).json({ error: 'BrowserSession not ready' });
            return;
        }

        const result = browserSession.prewarmChapterLists(mangaIds);
        res.status(202).json(result);
    }));

    router.post('/prewarm-chapter-details', asyncHandler(async (req, res) => {
        const { requests } = req.body as { requests?: PrewarmChapterDetailRequest[] };

        if (!Array.isArray(requests) || requests.length === 0) {
            res.status(400).json({ error: 'Missing requests array' });
            return;
        }

        if (!browserSession?.ready) {
            res.status(503).json({ error: 'BrowserSession not ready' });
            return;
        }

        const valid = requests.filter(r =>
            typeof r?.mangaId === 'string' &&
            typeof r?.chapterId === 'string' &&
            typeof r?.signingPageUrl === 'string'
        );
        const result = browserSession.prewarmChapterDetails(valid);
        res.status(202).json(result);
    }));

    return router;
}
