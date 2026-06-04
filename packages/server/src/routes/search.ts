import { Router } from 'express';
import type { SearchFilters } from '@manga-reader/provider-types';
import { asyncHandler } from '../middleware/errorHandler.js';
import { proxyFetchJson } from '../utils/proxyFetch.js';
import type { ProviderCoordinator } from '../services/ProviderCoordinator.js';
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

function providerIdFromBody(value: unknown): string {
  const body = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return typeof body.providerId === 'string' && body.providerId.length > 0 ? body.providerId : 'comix';
}

function requestIdFromBody(value: unknown): string {
  const body = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return typeof body.requestId === 'string' && body.requestId.length > 0 ? body.requestId : 'none';
}

export default function createSearchRouter(coordinator: ProviderCoordinator | null): Router {
  const router = Router();

  router.post('/search', asyncHandler(async (req, res) => {
    if (!coordinator) {
      res.status(503).json({ error: 'Provider coordinator unavailable', status: 503 });
      return;
    }
    const query = stringParam(req.body?.query).trim();
    const page = numberParam(req.body?.page, 1);
    const filters = filtersFrom(req.body?.filters);
    const providerId = providerIdFromBody(req.body);
    const requestId = requestIdFromBody(req.body);
    const started = Date.now();
    const owner = coordinator.require(providerId);
    const provider = await getServerProvider(providerId);
    if (owner.provider.id === 'mangadotnet' && !owner.browserSession.canServeRuntimeRequests()) {
      const warmStarted = Date.now();
      try {
        await owner.browserSession.warmRuntimeHttp('foreground-search');
      } catch (error) {
        console.log(`[search] provider=${provider.id} requestId=${requestId} mode=warm-failed query="${query || '(browse)'}" page=${page} http=503 reason=${String((error as Error)?.message ?? error)} ${Date.now() - warmStarted}ms`);
        res.status(503).json({ error: 'Provider runtime not ready', status: 503, providerId: provider.id });
        return;
      }
      if (!owner.browserSession.canServeRuntimeRequests()) {
        console.log(`[search] provider=${provider.id} requestId=${requestId} mode=unavailable query="${query || '(browse)'}" page=${page} http=503 reason=provider-runtime-not-ready ${Date.now() - warmStarted}ms`);
        res.status(503).json({ error: 'Provider runtime not ready', status: 503, providerId: provider.id });
        return;
      }
    }
    const upstream = provider.searchRequest(query, page, filters);
    const mangadotPath = owner.provider.id === 'mangadotnet' ? new URL(upstream.url).pathname : '';
    const fetched = owner.provider.id === 'mangadotnet' && mangadotPath === '/search'
      ? {
          data: (await owner.browserSession.fetchRuntimeDocument(upstream.url, {
            owner: 'search-route',
            priority: 'foreground',
            reason: query || 'browse-filtered',
          })).html,
          meta: { status: 200 },
        }
      : owner.provider.id === 'mangadotnet'
      ? {
          data: (await owner.browserSession.fetchRuntimeApi(upstream.url, {
            owner: 'search-route',
            priority: 'foreground',
            reason: query || 'browse',
          })).data,
          meta: { status: 200 },
        }
      : await proxyFetchJson(upstream.url, {
          method: upstream.method,
          headers: upstream.headers,
          body: upstream.body,
          cloudflareProtected: upstream.cloudflareProtected,
        });
    const { data, meta } = fetched;
    const parsed = provider.parseSearchResponse(data);
    console.log(`[search] provider=${provider.id} requestId=${requestId} mode=${mangadotPath === '/search' ? 'document' : 'api'} query="${query || '(browse)'}" page=${page} http=${meta.status} count=${parsed.items.length} current=${parsed.pagination?.currentPage ?? page} last=${parsed.pagination?.lastPage ?? 'unknown'} total=${parsed.pagination?.total ?? parsed.items.length} ${Date.now() - started}ms`);
    res.json(data);
  }));

  return router;
}
