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

/** Application-level 403 wrapped in HTTP 200 — needs signed browser request. */
function isSoft403(data: unknown): boolean {
    if (typeof data !== 'object' || data === null) return false;
    const d = data as Record<string, unknown>;
    return d.status === 403 && d.result === null;
}

/**
 * Factory: proxy route borrows BrowserSession for soft-403 fallback.
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

        const { response: r, meta } = await proxyFetch(url, {
            method,
            headers: {
                'User-Agent': req.headers['user-agent'] || '',
                ...headers,
            },
            body: body ?? undefined,
            cloudflareProtected,
        });
        const parsed = new URL(url);
        const pathStr = parsed.pathname + (parsed.search ? parsed.search : '');
        console.log(`[proxy] ${method} ${pathStr} ${r.status} ${meta.durationMs}ms`);

        if (responseType === 'text') {
            const text = await r.text();
            res.set('Content-Type', 'text/plain; charset=utf-8');
            res.send(text);
        } else {
            const data = await r.json();

            if (isSoft403(data) && browserSession?.ready) {
                console.log(`[proxy] soft-403 ${pathStr} — retrying via browser`);
                try {
                    const result = await browserSession.signedFetch(url);
                    console.log(`[proxy] browser-ok ${pathStr} ${result.durationMs}ms`);
                    res.json(result.data);
                    return;
                } catch (e) {
                    console.log(`[proxy] browser-fail ${pathStr} ${(e as Error).message}`);
                }
            }

            res.json(data);
        }
    }));

    return router;
}
