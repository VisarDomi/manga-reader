import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler';
import { proxyFetch, CloudflareError } from '../utils/proxyFetch';

const router = Router();

interface ProxyBody {
    url: string;
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    responseType?: 'json' | 'text';
    cloudflareProtected?: boolean;
}

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

    try {
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
        const path = parsed.pathname + (parsed.search ? parsed.search : '');
        console.log(`[proxy] ${method} ${path} ${r.status} ${meta.durationMs}ms`);

        if (responseType === 'text') {
            const text = await r.text();
            res.set('Content-Type', 'text/plain; charset=utf-8');
            res.send(text);
        } else {
            const data = await r.json();
            res.json(data);
        }
    } catch (e) {
        if (e instanceof CloudflareError) {
            res.status(503).set('X-Cloudflare-Solving', 'true').json({ error: 'cloudflare', solving: true });
            return;
        }
        throw e;
    }
}));

export default router;
