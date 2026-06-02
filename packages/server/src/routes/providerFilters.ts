import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import type { ProviderCoordinator } from '../services/ProviderCoordinator.js';

function singleParam(value: string | string[] | undefined): string {
    return typeof value === 'string' ? value : '';
}

export default function providerFiltersRouter(coordinator: ProviderCoordinator | null): Router {
    const router = Router();

    router.get('/providers', asyncHandler(async (_req, res) => {
        if (!coordinator) {
            res.status(503).json({ error: 'Provider coordinator unavailable' });
            return;
        }
        res.json({ status: 'ok', result: coordinator.list() });
    }));

    router.get('/provider-filters/:providerId', asyncHandler(async (req, res) => {
        if (!coordinator) {
            res.status(503).json({ error: 'Provider coordinator unavailable' });
            return;
        }
        const owner = coordinator.get(singleParam(req.params.providerId));
        if (!owner) {
            res.status(404).json({ error: 'Unknown provider' });
            return;
        }

        const result = await owner.provider.getFilterCatalog();
        console.log(`[providerFilters] serve provider=${owner.provider.id} source=${result.source} ageMs=${result.ageMs}`);
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
        if (!coordinator) {
            res.status(503).json({ error: 'Provider coordinator unavailable' });
            return;
        }
        const owner = coordinator.get(singleParam(req.params.providerId));
        const type = typeof req.params.type === 'string' ? req.params.type : '';
        const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim() : '';
        if (!owner) {
            res.status(404).json({ error: 'Unknown filter search' });
            return;
        }
        if (keyword.length < 2) {
            res.json({ status: 'ok', result: [] });
            return;
        }

        const url = owner.provider.filterSearchUrl(type, keyword);
        if (!url) {
            res.status(404).json({ error: 'Unknown filter search' });
            return;
        }
        const started = Date.now();
        const data = owner.provider.id === 'mangadotnet'
            ? (await owner.browserSession.fetchRuntimeApi(url, {
                owner: 'provider-filter-search',
                priority: 'foreground',
                reason: `${type}:${keyword}`,
            })).data
            : await fetch(url, {
                headers: {
                    Accept: 'application/json',
                    'User-Agent': 'Mozilla/5.0 manga-reader filter-search',
                },
            }).then(async upstream => {
                const data = await upstream.json() as unknown;
                if (!upstream.ok) {
                    const error = new Error(`HTTP ${upstream.status}`);
                    Object.assign(error, { status: upstream.status, data });
                    throw error;
                }
                return data;
            });
        const count = Array.isArray((data as Record<string, unknown>)?.result) ? ((data as Record<string, unknown>).result as unknown[]).length : 0;
        console.log(`[providerFilters] search provider=${owner.provider.id} type=${type} keyword="${keyword}" count=${count} ${Date.now() - started}ms`);
        res.json(data);
    }));

    return router;
}
