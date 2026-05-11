import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import type { CacheJobPriority, CacheReconcileSource, CacheService } from '../cache/CacheService.js';
import type { ByteCacheService } from '../cache/ByteCacheService.js';
import type { MangaCoverVariant } from '../cache/sqlite.js';

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

export function createCacheRouter(cache: CacheService | null, byteCache: ByteCacheService | null = null): Router {
  const router = Router();

  router.get('/cache/status', asyncHandler(async (_req, res) => {
    if (!cache) {
      res.status(503).json({ error: 'Cache service unavailable', status: 503 });
      return;
    }
    res.json(cache.status());
  }));

  router.get('/cache/manga/:mangaId/cover/:variant', asyncHandler(async (req, res) => {
    if (!byteCache) {
      res.status(503).json({ error: 'Cover cache unavailable', status: 503 });
      return;
    }
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
    await byteCache.streamCover(mangaId, variant, sourceUrl, res, String(callerUA), req.query.referer as string | undefined);
  }));

  router.post('/cache/manga/cards', asyncHandler(async (req, res) => {
    if (!cache) {
      res.status(503).json({ error: 'Cache service unavailable', status: 503 });
      return;
    }
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
      : [];
    if (ids.length === 0) {
      res.status(400).json({ error: 'Missing ids', status: 400 });
      return;
    }
    res.json({
      status: 'ok',
      result: {
        items: cache.getMangaCardSnapshots(ids, { includeChapters: req.body?.includeChapters === true }),
      },
    });
  }));

  router.get('/cache/manga/:mangaId', asyncHandler(async (req, res) => {
    if (!cache) {
      res.status(503).json({ error: 'Cache service unavailable', status: 503 });
      return;
    }
    const mangaId = singleParam(req.params.mangaId);
    if (!mangaId) {
      res.status(400).json({ error: 'Missing mangaId', status: 400 });
      return;
    }
    const data = cache.getManga(mangaId);
    if (!data) {
      cache.warmManga(mangaId, 'cache-miss');
      res.status(202).json({ status: 'warming', mangaId });
      return;
    }
    res.json(data);
  }));

  router.get('/cache/manga/:mangaId/chapters', asyncHandler(async (req, res) => {
    if (!cache) {
      res.status(503).json({ error: 'Cache service unavailable', status: 503 });
      return;
    }
    const mangaId = singleParam(req.params.mangaId);
    if (!mangaId) {
      res.status(400).json({ error: 'Missing mangaId', status: 400 });
      return;
    }
    const data = cache.getChapterList(mangaId);
    if (!data) {
      if (!cache.isChapterListWarming(mangaId)) {
        cache.warmManga(mangaId, 'cache-miss');
      }
      res.status(202).json({ status: 'warming', mangaId });
      return;
    }
    res.json(data);
  }));

  router.get('/cache/manga/:mangaId/chapters/:chapterId/images', asyncHandler(async (req, res) => {
    if (!cache) {
      res.status(503).json({ error: 'Cache service unavailable', status: 503 });
      return;
    }
    const mangaId = singleParam(req.params.mangaId);
    const chapterId = singleParam(req.params.chapterId);
    if (!mangaId || !chapterId) {
      res.status(400).json({ error: 'Missing mangaId or chapterId', status: 400 });
      return;
    }
    const data = cache.getChapterImages(mangaId, chapterId);
    if (!data) {
      const rawNumber = typeof req.query.number === 'string' ? Number(req.query.number) : NaN;
      const chapterNumber = Number.isFinite(rawNumber) ? rawNumber : undefined;
      const chapterUrl = typeof req.query.url === 'string' ? req.query.url : undefined;
      cache.warmChapterImages(mangaId, chapterId, chapterNumber, chapterUrl, 'cache-miss');
      res.status(202).json({ status: 'warming', mangaId, chapterId });
      return;
    }
    res.json(data);
  }));

  router.post('/cache/manga/:mangaId/refresh', asyncHandler(async (req, res) => {
    if (!cache) {
      res.status(503).json({ error: 'Cache service unavailable', status: 503 });
      return;
    }
    const mangaId = singleParam(req.params.mangaId);
    if (!mangaId) {
      res.status(400).json({ error: 'Missing mangaId', status: 400 });
      return;
    }
    cache.refreshManga(mangaId, 'frontend-refresh');
    res.status(202).json({ status: 'queued', mangaId });
  }));

  router.post('/cache/manga/:mangaId/reconcile', asyncHandler(async (req, res) => {
    if (!cache) {
      res.status(503).json({ error: 'Cache service unavailable', status: 503 });
      return;
    }
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
    const priority: CacheJobPriority = req.body?.priority === 'foreground' ? 'foreground' : 'observed';
    const source: CacheReconcileSource =
      req.body?.source === 'manga-open' || req.body?.source === 'manual-refresh'
        ? req.body.source
        : 'search-result';
    const result = cache.reconcileManga(
      mangaId,
      Number.isFinite(observedLatestChapter) ? observedLatestChapter : null,
      priority,
      source,
    );
    res.status(result.status === 'fresh' || result.status === 'ignored' ? 200 : 202).json(result);
  }));

  router.post('/cache/image-store', asyncHandler(async (req, res) => {
    if (!cache) {
      res.status(503).json({ error: 'Cache service unavailable', status: 503 });
      return;
    }
    const { imageUrl, storeUrl, status, ok } = req.body as {
      imageUrl?: string;
      storeUrl?: string;
      status?: number;
      ok?: boolean;
    };
    if (!imageUrl || !storeUrl || typeof status !== 'number' || !Number.isFinite(status) || typeof ok !== 'boolean') {
      res.status(400).json({ error: 'Missing imageUrl, storeUrl, status, or ok', status: 400 });
      return;
    }
    cache.observeImageStore({ imageUrl, storeUrl, status, ok });
    res.status(202).json({ status: 'recorded' });
  }));

  return router;
}
