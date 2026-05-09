import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import type { CacheService } from '../cache/CacheService.js';

function singleParam(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}

export function createCacheRouter(cache: CacheService | null): Router {
  const router = Router();

  router.get('/cache/status', asyncHandler(async (_req, res) => {
    if (!cache) {
      res.status(503).json({ error: 'Cache service unavailable', status: 503 });
      return;
    }
    res.json(cache.status());
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
      res.status(404).json({ error: 'Manga cache miss', status: 404 });
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
      cache.refreshManga(mangaId, 'cache-miss');
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
      cache.refreshChapterImages(mangaId, chapterId, chapterNumber, chapterUrl, 'cache-miss');
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
