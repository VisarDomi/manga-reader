import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { proxyFetchJson, proxyFetchText } from '../utils/proxyFetch.js';
import type { BrowserSession } from '../services/BrowserSession.js';

interface ProxyBody {
    url: string;
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    responseType?: 'json' | 'text';
    cloudflareProtected?: boolean;
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

        if (browserSession?.ready && browserSession.needsSigning(url)) {
            try {
                const result = await browserSession.signedFetch(url);
                console.log(`[proxy] signed ${pathStr} ${result.durationMs}ms`);
                res.json(result.data);
                return;
            } catch (e) {
                console.log(`[proxy] signed-fail ${pathStr} ${(e as Error).message}`);
            }
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
            console.log(`[proxy] ${method} ${pathStr} ${meta.status} ${meta.durationMs}ms`);
            res.set('Content-Type', 'text/plain; charset=utf-8');
            res.send(data);
        } else {
            const { data, meta } = await proxyFetchJson(url, fetchOpts);
            console.log(`[proxy] ${method} ${pathStr} ${meta.status} ${meta.durationMs}ms`);
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
