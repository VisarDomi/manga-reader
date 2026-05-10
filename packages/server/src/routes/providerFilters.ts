import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { comixServerProvider } from '../providers/comix.js';

const router = Router();

router.get('/provider-filters/:providerId', asyncHandler(async (req, res) => {
    const providerId = req.params.providerId;
    if (providerId !== comixServerProvider.id) {
        res.status(404).json({ error: 'Unknown provider' });
        return;
    }

    const result = await comixServerProvider.getFilterCatalog();
    console.log(`[providerFilters] serve ${providerId} source=${result.source} ageMs=${result.ageMs}`);
    res.json({
        status: 'ok',
        result: result.filters,
        meta: {
            source: result.source,
            ageMs: result.ageMs,
            ttlMs: 24 * 60 * 60 * 1000,
        },
    });
}));

router.get('/provider-filter-search/:providerId/:type', asyncHandler(async (req, res) => {
    const providerId = typeof req.params.providerId === 'string' ? req.params.providerId : '';
    const type = typeof req.params.type === 'string' ? req.params.type : '';
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim() : '';
    if (providerId !== comixServerProvider.id) {
        res.status(404).json({ error: 'Unknown filter search' });
        return;
    }
    if (keyword.length < 2) {
        res.json({ status: 'ok', result: [] });
        return;
    }

    const url = comixServerProvider.filterSearchUrl(type, keyword);
    if (!url) {
        res.status(404).json({ error: 'Unknown filter search' });
        return;
    }
    const started = Date.now();
    const upstream = await fetch(url, {
        headers: {
            Accept: 'application/json',
            'User-Agent': 'Mozilla/5.0 manga-reader filter-search',
        },
    });
    const data = await upstream.json() as unknown;
    const count = Array.isArray((data as Record<string, unknown>)?.result) ? ((data as Record<string, unknown>).result as unknown[]).length : 0;
    console.log(`[providerFilters] search ${providerId}/${type} keyword="${keyword}" http=${upstream.status} count=${count} ${Date.now() - started}ms`);
    res.status(upstream.ok ? 200 : upstream.status).json(data);
}));

export default router;
