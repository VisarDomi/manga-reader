import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler';
import { scrapeChapterImages } from '../services/scraper';

const SLUG_PATTERN = /^[a-z0-9-]+$/;
const ALPHANUM_PATTERN = /^[a-zA-Z0-9]+$/;

const router = Router();

router.get('/chapter/:slug/:chapterId/:chapterNumber', asyncHandler(async (req, res) => {
  const slug = req.params.slug as string;
  const chapterId = req.params.chapterId as string;
  const chapterNumber = req.params.chapterNumber as string;

  if (!SLUG_PATTERN.test(slug)) {
    res.status(400).json({ error: 'Invalid slug format. Must match /^[a-z0-9-]+$/', status: 400 });
    return;
  }

  if (!ALPHANUM_PATTERN.test(chapterId)) {
    res.status(400).json({ error: 'chapterId must be alphanumeric', status: 400 });
    return;
  }

  const num = Number(chapterNumber);
  if (isNaN(num) || num <= 0) {
    res.status(400).json({ error: 'chapterNumber must be a positive number', status: 400 });
    return;
  }

  const images = await scrapeChapterImages(slug, chapterId, chapterNumber);
  res.json({ images });
}));

export default router;
