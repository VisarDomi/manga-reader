import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler';
import { proxyFetch } from '../utils/proxyFetch';
import type { BrowserSession } from '../services/BrowserSession';

interface ProxyBody {
    url: string;
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    responseType?: 'json' | 'text';
    cloudflareProtected?: boolean;
}

/**
 * Factory: proxy route borrows BrowserSession for signed endpoints.
 * Ownership: BrowserSession is owned by the server, borrowed here.
 */
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

        // Signed endpoints go straight to BrowserSession — no wasted proxyFetch.
        if (browserSession?.ready && browserSession.needsSigning(url)) {
            try {
                const result = await browserSession.signedFetch(url);
                console.log(`[proxy] signed ${pathStr} ${result.durationMs}ms`);
                res.json(result.data);
                return;
            } catch (e) {
                console.log(`[proxy] signed-fail ${pathStr} ${(e as Error).message}`);
                // Fall through to proxyFetch as last resort
            }
        }

        const { response: r, meta } = await proxyFetch(url, {
            method,
            headers: {
                'User-Agent': req.headers['user-agent'] || '',
                ...headers,
            },
            body: body ?? undefined,
            cloudflareProtected,
        });
        console.log(`[proxy] ${method} ${pathStr} ${r.status} ${meta.durationMs}ms`);

        if (responseType === 'text') {
            const text = await r.text();
            res.set('Content-Type', 'text/plain; charset=utf-8');
            res.send(text);
        } else {
            const data = await r.json();
            res.json(data);
        }
    }));

    // Prewarm signatures for a batch of manga IDs.
    // Frontend calls this with visible manga IDs from the list view.
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

        // Fire and forget — don't block the response
        browserSession.prewarmSigs(mangaIds).catch(() => {});
        res.status(202).json({ queued: mangaIds.length });
    }));

    return router;
}
