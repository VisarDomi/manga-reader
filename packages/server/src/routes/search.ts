import { Router } from 'express';
import type { HttpRequest, SearchFilters } from '@manga-reader/provider-types';
import { asyncHandler } from '../middleware/errorHandler.js';
import { proxyFetchJson } from '../utils/proxyFetch.js';
import type { ProviderCoordinator } from '../services/ProviderCoordinator.js';
import { getServerProvider } from '../services/providerRuntime.js';
import type { ProviderRuntimeOwner } from '../services/ProviderCoordinator.js';
import type { ProviderSearchTransport } from '../providers/types.js';

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

function transportNeedsRuntime(transport: ProviderSearchTransport): boolean {
  return transport.mode === 'runtime-api'
    || transport.mode === 'runtime-document'
    || (transport.fallback ? transportNeedsRuntime(transport.fallback) : false);
}

async function ensureSearchRuntime(owner: ProviderRuntimeOwner, transport: ProviderSearchTransport, query: string, page: number, requestId: string): Promise<boolean> {
  if (!transportNeedsRuntime(transport) || owner.browserSession.canServeRuntimeRequests()) return true;
  const started = Date.now();
  try {
    await owner.browserSession.warmRuntimeHttp('foreground-search');
  } catch (error) {
    console.log(`[search] provider=${owner.provider.id} requestId=${requestId} mode=warm-failed query="${query || '(browse)'}" page=${page} http=503 reason=${String((error as Error)?.message ?? error)} ${Date.now() - started}ms`);
    return false;
  }
  if (owner.browserSession.canServeRuntimeRequests()) return true;
  console.log(`[search] provider=${owner.provider.id} requestId=${requestId} mode=unavailable query="${query || '(browse)'}" page=${page} http=503 reason=provider-runtime-not-ready ${Date.now() - started}ms`);
  return false;
}

async function fetchByTransport(owner: ProviderRuntimeOwner, upstream: HttpRequest, transport: ProviderSearchTransport, query: string, modeReason: string) {
  const runtimePath = transport.runtimePath ?? upstream.url;
  switch (transport.mode) {
    case 'runtime-document':
      return {
        data: (await owner.browserSession.fetchRuntimeDocument(runtimePath, {
          owner: 'search-route',
          priority: 'foreground',
          reason: query || modeReason,
        })).html,
        meta: { status: 200 },
        mode: transport.mode,
      };
    case 'runtime-api':
      return {
        data: (await owner.browserSession.fetchRuntimeApi(runtimePath, {
          owner: 'search-route',
          priority: 'foreground',
          reason: query || modeReason,
        })).data,
        meta: { status: 200 },
        mode: transport.mode,
      };
    case 'proxy': {
      const fetched = await proxyFetchJson(upstream.url, {
        method: upstream.method,
        headers: upstream.headers,
        body: upstream.body,
        cloudflareProtected: upstream.cloudflareProtected,
      });
      return { ...fetched, mode: transport.mode };
    }
  }
}

async function fetchProviderSearch(owner: ProviderRuntimeOwner, upstream: HttpRequest, transport: ProviderSearchTransport, query: string, page: number, requestId: string) {
  try {
    return await fetchByTransport(owner, upstream, transport, query, 'browse');
  } catch (error) {
    if (!transport.fallback) throw error;
    console.log(`[search] provider=${owner.provider.id} requestId=${requestId} mode=${transport.mode}-failed query="${query || '(browse)'}" page=${page} fallback=${transport.fallback.mode} reason=${String((error as Error)?.message ?? error)}`);
    return await fetchByTransport(owner, upstream, transport.fallback, query, 'browse-fallback');
  }
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
    const upstream = provider.searchRequest(query, page, filters);
    const transport = owner.provider.searchTransport(upstream.url);
    if (!await ensureSearchRuntime(owner, transport, query, page, requestId)) {
      res.status(503).json({ error: 'Provider runtime not ready', status: 503, providerId: provider.id });
      return;
    }
    const fetched = await fetchProviderSearch(owner, upstream, transport, query, page, requestId);
    const { data, meta } = fetched;
    const parsed = provider.parseSearchResponse(data);
    owner.cache.warmSearchResultCovers(parsed.items, { page, requestId });
    console.log(`[search] provider=${provider.id} requestId=${requestId} mode=${fetched.mode} query="${query || '(browse)'}" page=${page} http=${meta.status} count=${parsed.items.length} current=${parsed.pagination?.currentPage ?? page} last=${parsed.pagination?.lastPage ?? 'unknown'} total=${parsed.pagination?.total ?? parsed.items.length} ${Date.now() - started}ms`);
    res.json(data);
  }));

  return router;
}
