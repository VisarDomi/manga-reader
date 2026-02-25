import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler';
import { fetchChapters } from '../services/comix';

const SLUG_PATTERN = /^[a-z0-9-]+$/;

const router = Router();

router.get('/manga/:slug/chapters', asyncHandler(async (req, res) => {
  const slug = req.params.slug as string;
  if (!SLUG_PATTERN.test(slug)) {
    res.status(400).json({ error: 'Invalid slug format. Must match /^[a-z0-9-]+$/', status: 400 });
    return;
  }

  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    res.status(400).json({ error: 'limit must be a positive integer', status: 400 });
    return;
  }

  const page = req.query.page ? Number(req.query.page) : undefined;
  if (page !== undefined && (!Number.isInteger(page) || page < 1)) {
    res.status(400).json({ error: 'page must be a positive integer', status: 400 });
    return;
  }

  const data = await fetchChapters(slug, limit ?? undefined, page ?? undefined);
  res.json(data);
}));

export default router;
