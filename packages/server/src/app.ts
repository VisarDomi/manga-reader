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
import logRouter from './routes/log';
import type { Request, Response } from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

const providersDir = path.join(__dirname, '..', '..', 'extensions', 'dist');
if (fs.existsSync(providersDir)) {
  app.use('/providers', express.static(providersDir, {
    setHeaders: (res) => { res.set('Cache-Control', 'no-cache'); },
  }));
}

if (fs.existsSync(FRONTEND_BUILD_DIR)) {
  app.use('/_app/immutable', express.static(path.join(FRONTEND_BUILD_DIR, '_app', 'immutable'), {
    setHeaders: (res) => { res.set('Cache-Control', 'public, max-age=31536000, immutable'); },
  }));
  app.use(express.static(FRONTEND_BUILD_DIR, {
    setHeaders: (res) => { res.set('Cache-Control', 'no-cache'); },
  }));
}

app.use('/api', healthRouter);
app.use('/api', imageRouter);
app.use('/api', certRouter);
app.use('/api', proxyRouter);
app.use('/api', logRouter);

app.get(/^\/(?!api).*/, (_req: Request, res: Response) => {
  const indexPath = path.join(FRONTEND_BUILD_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Frontend not built');
  }
});

app.use(errorHandler);

export default app;
