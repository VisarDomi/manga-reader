import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { isAllowedImageDomain, streamImage } from '../services/imageProxy.js';

const router = Router();

router.get('/image', asyncHandler(async (req, res) => {
  const imageUrl = req.query.url as string | undefined;
  if (!imageUrl) {
    res.status(400).json({ error: 'Missing url parameter', status: 400 });
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    res.status(400).json({ error: 'Invalid URL', status: 400 });
    return;
  }

  if (!isAllowedImageDomain(parsed.hostname)) {
    res.status(403).json({ error: 'Only comix.to domains are allowed', status: 403 });
    return;
  }

  const referer = req.query.referer as string | undefined;
  const callerUA = req.headers['user-agent'] || '';
  await streamImage(imageUrl, res, callerUA, referer);
}));

export default router;
