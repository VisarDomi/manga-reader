import { Router } from 'express';
import type { Request, Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import type { CacheJobPriority, CacheReconcileSource } from '../cache/CacheService.js';
import type { MangaCoverVariant } from '../cache/sqlite.js';
import type { ProviderCoordinator, ProviderRuntimeOwner } from '../services/ProviderCoordinator.js';

function isAllowedImageDomain(_hostname: string): boolean {
  return true;
}

function singleParam(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}

function coverVariant(value: string | string[] | undefined): MangaCoverVariant | null {
  return value === 'card' || value === 'detail' ? value : null;
}

function mangaIdFromCardItem(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const record = item as Record<string, unknown>;
  for (const key of ['id', 'hid', 'slug']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function requestedPriority(value: unknown): CacheJobPriority {
  return value === 'interactive'
    ? 'interactive'
    : value === 'foreground'
      ? 'foreground'
      : value === 'observed'
        ? 'observed'
        : 'interactive';
}

function attachCacheState(data: unknown, state: Record<string, unknown>): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  return {
    ...(data as Record<string, unknown>),
    cache: state,
  };
}

function providerIdFromRequest(req: Request): string {
  const queryId = typeof req.query?.providerId === 'string' ? req.query.providerId : null;
  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const bodyId = typeof body.providerId === 'string' ? body.providerId : null;
  const headerId = typeof req.headers?.['x-provider-id'] === 'string' ? req.headers['x-provider-id'] : null;
  return queryId || bodyId || headerId || 'comix';
}

function requireOwner(coordinator: ProviderCoordinator | null, req: Request, res: Response): ProviderRuntimeOwner | null {
  if (!coordinator) {
    res.status(503).json({ error: 'Provider coordinator unavailable', status: 503 });
    return null;
  }
  const providerId = providerIdFromRequest(req);
  const owner = coordinator.get(providerId);
  if (!owner) {
    res.status(404).json({ error: `Unknown provider: ${providerId}`, status: 404 });
    return null;
  }
  return owner;
}

function requestAbortSignal(req: Request): AbortSignal {
  const controller = new AbortController();
  req.on('close', () => controller.abort(new DOMException('Request closed', 'AbortError')));
  return controller.signal;
}

export function createCacheRouter(coordinator: ProviderCoordinator | null): Router {
  const router = Router();

  router.get('/cache/status', asyncHandler(async (req, res) => {
    if (!coordinator) {
      res.status(503).json({ error: 'Provider coordinator unavailable', status: 503 });
      return;
    }
    const requested = coordinator.get(providerIdFromRequest(req));
    if (requested) {
      res.json(requested.cache.status());
      return;
    }
    res.json({ providers: coordinator.list() });
  }));

  router.get('/cache/manga/:mangaId/cover/:variant', asyncHandler(async (req, res) => {
    const owner = requireOwner(coordinator, req, res);
    if (!owner) return;
    const mangaId = singleParam(req.params.mangaId);
    const variant = coverVariant(req.params.variant);
    if (!mangaId || !variant) {
      res.status(400).json({ error: 'Missing mangaId or cover variant', status: 400 });
      return;
    }
    const sourceUrl = typeof req.query.source === 'string' && req.query.source.length > 0
      ? req.query.source
      : undefined;
    if (sourceUrl) {
      let parsed: URL;
      try {
        parsed = new URL(sourceUrl);
      } catch {
        res.status(400).json({ error: 'Invalid cover source URL', status: 400 });
        return;
      }
      if (!isAllowedImageDomain(parsed.hostname)) {
        res.status(403).json({ error: 'Only image provider domains are allowed', status: 403 });
        return;
      }
    }
    const callerUA = req.headers['user-agent'] || '';
    await owner.byteCache.streamCover(mangaId, variant, sourceUrl, res, String(callerUA), req.query.referer as string | undefined);
  }));

  router.post('/cache/manga/cards', asyncHandler(async (req, res) => {
    const startedAt = Date.now();
    const owner = requireOwner(coordinator, req, res);
    if (!owner) return;
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const rawItems = Array.isArray(body.items) ? body.items : [];
    const fallbackItems = rawItems.length > 0
      ? rawItems.filter((item: unknown) => mangaIdFromCardItem(item) != null)
      : [];
    const fallbackIds = fallbackItems
      .map((item: unknown) => mangaIdFromCardItem(item))
      .filter((id: string | null): id is string => id != null);
    const ids = fallbackIds.length > 0
      ? fallbackIds
      : Array.isArray(body.ids)
      ? body.ids.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
      : [];
    if (ids.length === 0) {
      res.status(400).json({ error: 'Missing ids', status: 400 });
      return;
    }
    const includeChapters = body.includeChapters === true;
    const result = owner.cache.getMangaCardSnapshots(ids, { includeChapters });
    owner.cache.warmMangaCardCovers(
      result.map(item => item.manga).filter(Boolean),
      'card-snapshot',
      'observed',
    );
    if (fallbackItems.length > 0) {
      owner.cache.warmMangaCardCovers(fallbackItems, 'card-fallback', 'observed');
    }
    console.log(`[cacheRoute] manga-card-snapshots ids=${ids.length} fallbackItems=${fallbackItems.length} unique=${new Set(ids).size} includeChapters=${includeChapters} mangaReady=${result.filter(item => item.mangaReady).length} chaptersReady=${result.filter(item => item.chaptersReady).length} totalMs=${Date.now() - startedAt}`);
    res.json({
      status: 'ok',
      result: {
        items: result,
      },
    });
  }));

  router.get('/cache/manga/:mangaId', asyncHandler(async (req, res) => {
    const owner = requireOwner(coordinator, req, res);
    if (!owner) return;
    const mangaId = singleParam(req.params.mangaId);
    if (!mangaId) {
      res.status(400).json({ error: 'Missing mangaId', status: 400 });
      return;
    }
    const result = await owner.cache.getMangaForRequest(mangaId, {
      priority: requestedPriority(req.query.priority),
      signal: requestAbortSignal(req),
    });
    if (!result.data) {
      res.status(202).json({ status: 'warming', mangaId });
      return;
    }
    if (result.waitedMs > 0) {
      res.setHeader('X-Cache-Waited-Ms', String(result.waitedMs));
      res.setHeader('X-Cache-Wait-Status', result.status);
    }
    res.json(result.data);
  }));

  router.get('/cache/manga/:mangaId/chapters', asyncHandler(async (req, res) => {
    const owner = requireOwner(coordinator, req, res);
    if (!owner) return;
    const mangaId = singleParam(req.params.mangaId);
    if (!mangaId) {
      res.status(400).json({ error: 'Missing mangaId', status: 400 });
      return;
    }
    const data = owner.cache.getChapterList(mangaId);
    if (!data) {
      owner.cache.warmManga(mangaId, 'cache-miss', requestedPriority(req.query.priority));
      console.log(`[cacheRoute] chapters manga=${mangaId} status=warming reason=miss`);
      res.status(202).json({ status: 'warming', mangaId });
      return;
    }
    const updating = owner.cache.isChapterListWarming(mangaId);
    const result = data && typeof data === 'object' ? (data as Record<string, unknown>).result : null;
    const resultRecord = result && typeof result === 'object' ? result as Record<string, unknown> : {};
    const items = Array.isArray(resultRecord.items) ? resultRecord.items.length : 0;
    console.log(`[cacheRoute] chapters manga=${mangaId} status=hit updating=${updating} items=${items}`);
    res.json(attachCacheState(data, { updating }));
  }));

  router.get('/cache/manga/:mangaId/chapters/:chapterId/images', asyncHandler(async (req, res) => {
    const owner = requireOwner(coordinator, req, res);
    if (!owner) return;
    const mangaId = singleParam(req.params.mangaId);
    const chapterId = singleParam(req.params.chapterId);
    if (!mangaId || !chapterId) {
      res.status(400).json({ error: 'Missing mangaId or chapterId', status: 400 });
      return;
    }
    const rawNumber = typeof req.query.number === 'string' ? Number(req.query.number) : NaN;
    const chapterNumber = Number.isFinite(rawNumber) ? rawNumber : undefined;
    const chapterUrl = typeof req.query.url === 'string' ? req.query.url : undefined;
    const result = await owner.cache.getChapterImagesForRequest(mangaId, chapterId, {
      chapterNumber,
      chapterUrl,
      priority: requestedPriority(req.query.priority),
      signal: requestAbortSignal(req),
    });
    if (!result.data) {
      res.status(202).json({ status: 'warming', mangaId, chapterId });
      return;
    }
    if (result.waitedMs > 0) {
      res.setHeader('X-Cache-Waited-Ms', String(result.waitedMs));
      res.setHeader('X-Cache-Wait-Status', result.status);
    }
    res.json(result.data);
  }));

  router.get('/cache/manga/:mangaId/chapters/:chapterId/pages/:pageIndex/decoded', asyncHandler(async (req, res) => {
    const owner = requireOwner(coordinator, req, res);
    if (!owner) return;
    const mangaId = singleParam(req.params.mangaId);
    const chapterId = singleParam(req.params.chapterId);
    const pageIndex = typeof req.params.pageIndex === 'string' ? Number(req.params.pageIndex) : NaN;
    if (!mangaId || !chapterId || !Number.isInteger(pageIndex) || pageIndex < 0) {
      res.status(400).json({ error: 'Missing mangaId, chapterId, or pageIndex', status: 400 });
      return;
    }
    const rawNumber = typeof req.query.number === 'string' ? Number(req.query.number) : NaN;
    const chapterNumber = Number.isFinite(rawNumber) ? rawNumber : undefined;
    const chapterUrl = typeof req.query.url === 'string' ? req.query.url : undefined;
    const policy = req.query.policy === 'critical' ? 'critical' : 'preload';
    const decoded = await owner.cache.decodeChapterPage(mangaId, chapterId, pageIndex, { chapterNumber, chapterUrl, policy });
    if (!decoded) {
      res.status(202).json({ status: 'warming', mangaId, chapterId, pageIndex });
      return;
    }
    res.setHeader('Content-Type', decoded.contentType);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-Decode-Duration-Ms', String(decoded.durationMs));
    res.send(decoded.buffer);
  }));

  router.get('/cache/manga/:mangaId/chapters/:chapterId/pages/:pageIndex/image', asyncHandler(async (req, res) => {
    const owner = requireOwner(coordinator, req, res);
    if (!owner) return;
    const mangaId = singleParam(req.params.mangaId);
    const chapterId = singleParam(req.params.chapterId);
    const pageIndex = typeof req.params.pageIndex === 'string' ? Number(req.params.pageIndex) : NaN;
    if (!mangaId || !chapterId || !Number.isInteger(pageIndex) || pageIndex < 0) {
      res.status(400).json({ error: 'Missing mangaId, chapterId, or pageIndex', status: 400 });
      return;
    }
    const rawNumber = typeof req.query.number === 'string' ? Number(req.query.number) : NaN;
    const chapterNumber = Number.isFinite(rawNumber) ? rawNumber : undefined;
    const chapterUrl = typeof req.query.url === 'string' ? req.query.url : undefined;
    const policy = req.query.policy === 'critical' ? 'critical' : 'preload';
    await owner.cache.streamChapterPageImage(mangaId, chapterId, pageIndex, res, { chapterNumber, chapterUrl, policy });
  }));

  router.post('/cache/manga/:mangaId/refresh', asyncHandler(async (req, res) => {
    const owner = requireOwner(coordinator, req, res);
    if (!owner) return;
    const mangaId = singleParam(req.params.mangaId);
    if (!mangaId) {
      res.status(400).json({ error: 'Missing mangaId', status: 400 });
      return;
    }
    owner.cache.refreshManga(mangaId, 'frontend-refresh');
    res.status(202).json({ status: 'queued', mangaId });
  }));

  router.post('/cache/manga/:mangaId/reconcile', asyncHandler(async (req, res) => {
    const owner = requireOwner(coordinator, req, res);
    if (!owner) return;
    const mangaId = singleParam(req.params.mangaId);
    if (!mangaId) {
      res.status(400).json({ error: 'Missing mangaId', status: 400 });
      return;
    }
    const observedLatestChapter = typeof req.body?.observedLatestChapter === 'number'
      ? req.body.observedLatestChapter
      : typeof req.body?.observedLatestChapter === 'string'
        ? Number(req.body.observedLatestChapter)
        : null;
    const priority: CacheJobPriority = req.body?.priority === 'interactive' ? 'interactive' : req.body?.priority === 'foreground' ? 'foreground' : 'observed';
    const source: CacheReconcileSource =
      req.body?.source === 'manga-open' || req.body?.source === 'manual-refresh'
        ? req.body.source
        : 'search-result';
    const result = owner.cache.reconcileManga(
      mangaId,
      Number.isFinite(observedLatestChapter) ? observedLatestChapter : null,
      priority,
      source,
    );
    res.status(result.status === 'fresh' || result.status === 'ignored' ? 200 : 202).json(result);
  }));

  router.post('/cache/image-store', asyncHandler(async (req, res) => {
    const owner = requireOwner(coordinator, req, res);
    if (!owner) return;
    const { imageUrl, storeUrl, status, ok, totalMs, sessionId } = req.body as {
      imageUrl?: string;
      storeUrl?: string;
      status?: number;
      ok?: boolean;
      totalMs?: number;
      sessionId?: string;
    };
    if (!imageUrl || !storeUrl || typeof status !== 'number' || !Number.isFinite(status) || typeof ok !== 'boolean') {
      res.status(400).json({ error: 'Missing imageUrl, storeUrl, status, or ok', status: 400 });
      return;
    }
    if (totalMs !== undefined && (typeof totalMs !== 'number' || !Number.isFinite(totalMs) || totalMs < 0)) {
      res.status(400).json({ error: 'Invalid totalMs', status: 400 });
      return;
    }
    owner.cache.observeImageStore({ imageUrl, storeUrl, status, ok, totalMs, sessionId });
    res.status(202).json({ status: 'recorded' });
  }));

  return router;
}
