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
    return 'items=none';
}

function logJsonProxy(method: string, pathStr: string, meta: ProxyFetchMeta, data: unknown): void {
    console.log(`[proxy] ${method} ${pathStr} http=${meta.status} api=${jsonApiStatus(data)} ${jsonResultSummary(data)} ${meta.durationMs}ms`);
}

export function createProxyRouter(browserSession: BrowserSession | null): Router {
    const router = Router();

    router.post('/proxy', asyncHandler(async (req, res) => {
        const { url, method = 'GET', headers = {}, body, responseType = 'json', cloudflareProtected } = req.body as ProxyBody;

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

        if (browserSession?.needsSigning(url)) {
            const result = await browserSession.signedFetch(url);
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

        browserSession.prewarmSigs(mangaIds);
        res.status(202).json({ queued: mangaIds.length });
    }));

    return router;
}
