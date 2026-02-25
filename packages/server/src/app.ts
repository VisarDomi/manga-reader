import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRONTEND_BUILD_DIR } from './config';
import { errorHandler } from './middleware/errorHandler';
import healthRouter from './routes/health';
import imageRouter from './routes/image';
import certRouter from './routes/cert';
import proxyRouter from './routes/proxy';
import type { Request, Response } from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// Provider bundles (extensions/dist/)
const providersDir = path.join(__dirname, '..', '..', 'extensions', 'dist');
if (fs.existsSync(providersDir)) {
  app.use('/providers', express.static(providersDir));
}

// Frontend static serving (built SvelteKit)
if (fs.existsSync(FRONTEND_BUILD_DIR)) {
  app.use(express.static(FRONTEND_BUILD_DIR));
}

// API routes
app.use('/api', healthRouter);
app.use('/api', imageRouter);
app.use('/api', certRouter);
app.use('/api', proxyRouter);

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
