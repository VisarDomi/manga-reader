import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRONTEND_BUILD_DIR } from './config.js';
import { errorHandler } from './middleware/errorHandler.js';
import healthRouter from './routes/health.js';
import imageRouter from './routes/image.js';
import certRouter from './routes/cert.js';
import { createProxyRouter } from './routes/proxy.js';
import logRouter from './routes/log.js';
import type { BrowserSession } from './services/BrowserSession.js';
import type { Request, Response } from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(browserSession: BrowserSession | null): express.Express {
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
    app.use('/api', createProxyRouter(browserSession));
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

    return app;
}
