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

    router.patch('/providers/:providerId/enabled', asyncHandler(async (req, res) => {
        if (!coordinator) {
            res.status(503).json({ error: 'Provider coordinator unavailable' });
            return;
        }
        const providerId = singleParam(req.params.providerId);
        const enabled = req.body?.enabled === true;
        try {
            const result = await coordinator.setEnabled(providerId, enabled);
            res.json({ status: 'ok', result });
        } catch (error) {
            res.status(400).json({ error: String((error as Error)?.message ?? error) });
        }
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

        const result = await owner.cache.getFilterCatalog();
        console.log(`[providerFilters] serve provider=${owner.provider.id} source=${result.source} ageMs=${result.ageMs} genres=${result.filters.genres.length} demographics=${result.filters.demographics?.length ?? 0}`);
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

        if (type !== 'tag' && type !== 'author' && type !== 'artist') {
            res.status(404).json({ error: 'Unknown filter search' });
            return;
        }
        const result = owner.cache.searchFilterOptions(type, keyword);
        res.json({ status: 'ok', result });
    }));

    return router;
}
