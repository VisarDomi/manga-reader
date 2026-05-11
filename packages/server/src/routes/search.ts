import { Router } from 'express';
import type { SearchFilters } from '@manga-reader/provider-types';
import { asyncHandler } from '../middleware/errorHandler.js';
import { proxyFetchJson } from '../utils/proxyFetch.js';
import { getServerProvider } from '../services/providerRuntime.js';

function stringParam(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function numberParam(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function filtersFrom(value: unknown): SearchFilters {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    includeGenres: stringArray(raw.includeGenres),
    excludeGenres: stringArray(raw.excludeGenres),
    demographics: stringArray(raw.demographics),
    authors: stringArray(raw.authors),
    artists: stringArray(raw.artists),
    types: stringArray(raw.types),
    statuses: stringArray(raw.statuses),
  };
}

export default function createSearchRouter(): Router {
  const router = Router();

  router.post('/search', asyncHandler(async (req, res) => {
    const query = stringParam(req.body?.query).trim();
    const page = numberParam(req.body?.page, 1);
    const filters = filtersFrom(req.body?.filters);
    const started = Date.now();
    const provider = await getServerProvider();
    const upstream = provider.searchRequest(query, page, filters);
    const { data, meta } = await proxyFetchJson(upstream.url, {
      method: upstream.method,
      headers: upstream.headers,
      body: upstream.body,
      cloudflareProtected: upstream.cloudflareProtected,
    });
    const parsed = provider.parseSearchResponse(data);
    console.log(`[search] query="${query || '(browse)'}" page=${page} http=${meta.status} count=${parsed.items.length} current=${parsed.pagination?.currentPage ?? page} last=${parsed.pagination?.lastPage ?? 'unknown'} total=${parsed.pagination?.total ?? parsed.items.length} ${Date.now() - started}ms`);
    res.json(data);
  }));

  return router;
}
