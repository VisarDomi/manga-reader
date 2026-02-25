import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler';
import { fetchSearch } from '../services/comix';

const router = Router();

router.get('/search', asyncHandler(async (req, res) => {
  const page = req.query.page;
  if (page !== undefined) {
    const n = Number(page);
    if (!Number.isInteger(n) || n < 1) {
      res.status(400).json({ error: 'page must be a positive integer', status: 400 });
      return;
    }
  }

  const data = await fetchSearch(req.query as Record<string, string | string[]>);
  res.json(data);
}));

export default router;
