import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { FRONTEND_BUILD_DIR } from './config';
import { errorHandler } from './middleware/errorHandler';
import healthRouter from './routes/health';
import searchRouter from './routes/search';
import chaptersRouter from './routes/chapters';
import chapterImagesRouter from './routes/chapterImages';
import imageRouter from './routes/image';
import historyRouter from './routes/history';
import certRouter from './routes/cert';
import favoritesRouter from './routes/favorites';
import type { Request, Response } from 'express';

const app = express();
app.use(express.json());

// Frontend static serving (built SvelteKit)
if (fs.existsSync(FRONTEND_BUILD_DIR)) {
  app.use(express.static(FRONTEND_BUILD_DIR));
}

// API routes
app.use('/api', healthRouter);
app.use('/api', searchRouter);
app.use('/api', chaptersRouter);
app.use('/api', chapterImagesRouter);
app.use('/api', imageRouter);
app.use('/api', historyRouter);
app.use('/api', certRouter);
app.use('/api', favoritesRouter);

// SPA fallback — serve index.html for non-API routes
app.get(/^\/(?!api).*/, (_req: Request, res: Response) => {
  const indexPath = path.join(FRONTEND_BUILD_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Frontend not built');
  }
});

// Catch-all error handler
app.use(errorHandler);

export default app;
