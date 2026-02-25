import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler';
import { postHistory, fetchHistory } from '../services/comix';
import { forwardAuthHeaders } from '../utils/forwardAuth';

const MANGA_ID_PATTERN = /^[a-zA-Z0-9-]+$/;

const router = Router();

router.post('/history', asyncHandler(async (req, res) => {
  const data = await postHistory(req.body, forwardAuthHeaders(req));
  res.json(data);
}));

router.get('/history/:mangaId', asyncHandler(async (req, res) => {
  const mangaId = req.params.mangaId as string;
  if (!MANGA_ID_PATTERN.test(mangaId)) {
    res.status(400).json({ error: 'Invalid mangaId format', status: 400 });
    return;
  }

  const data = await fetchHistory(mangaId, forwardAuthHeaders(req));
  res.json(data);
}));

export default router;
