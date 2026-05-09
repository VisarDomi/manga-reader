import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { isAllowedImageDomain } from '../services/imageProxy.js';
import type { ByteCacheService } from '../cache/ByteCacheService.js';

export function createByteRouter(byteCache: ByteCacheService | null): Router {
  const router = Router();

  router.get('/byte', asyncHandler(async (req, res) => {
    if (!byteCache) {
      res.status(503).json({ error: 'Byte cache unavailable', status: 503 });
      return;
    }

    const sourceUrl = req.query.url as string | undefined;
    if (!sourceUrl) {
      res.status(400).json({ error: 'Missing url parameter', status: 400 });
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(sourceUrl);
    } catch {
      res.status(400).json({ error: 'Invalid URL', status: 400 });
      return;
    }

    if (!isAllowedImageDomain(parsed.hostname)) {
      res.status(403).json({ error: 'Only image provider domains are allowed', status: 403 });
      return;
    }

    const referer = req.query.referer as string | undefined;
    const callerUA = req.headers['user-agent'] || '';
    await byteCache.stream(sourceUrl, res, String(callerUA), referer);
  }));

  return router;
}
