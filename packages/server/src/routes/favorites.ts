import { Router } from 'express';
import type { Request, Response } from 'express';
import * as favorites from '../services/favorites';

const SLUG_PATTERN = /^[a-z0-9-]+$/;

const router = Router();

router.get('/favorites', (_req: Request, res: Response) => {
  const items = favorites.readAll();
  res.json({ items });
});

router.put('/favorites/:slug', (req: Request, res: Response) => {
  const { slug } = req.params;
  if (!SLUG_PATTERN.test(slug)) {
    res.status(400).json({ error: 'Invalid slug format' });
    return;
  }

  const { title, cover, latestChapter, author, status } = req.body;
  if (!title || typeof title !== 'string') {
    res.status(400).json({ error: 'title is required' });
    return;
  }

  favorites.add(slug, {
    title,
    cover: cover ?? '',
    latestChapter: latestChapter ?? null,
    author,
    status,
  });
  res.json({ ok: true });
});

router.delete('/favorites/:slug', (req: Request, res: Response) => {
  const { slug } = req.params;
  if (!SLUG_PATTERN.test(slug)) {
    res.status(400).json({ error: 'Invalid slug format' });
    return;
  }

  favorites.remove(slug);
  res.json({ ok: true });
});

export default router;
