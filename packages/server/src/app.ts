import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRONTEND_BUILD_DIR } from './config.js';
import { errorHandler } from './middleware/errorHandler.js';
import healthRouter from './routes/health.js';
import certRouter from './routes/cert.js';
import { createCommentsRouter } from './routes/comments.js';
import { createCacheRouter } from './routes/cache.js';
import createSearchRouter from './routes/search.js';
import logRouter from './routes/log.js';
import providerFiltersRouter from './routes/providerFilters.js';
import type { ProviderCoordinator } from './services/ProviderCoordinator.js';
import type { Request, Response } from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STARTUP_ASSET_RE = /^\/($|index\.html$|_app\/|manifest\.json$|sw\.js$|apple-touch-icon\.png$|favicon|providers\/)/;
const STARTUP_ASSET_SLOW_MS = 1000;

function startupAssetLogger(req: Request, res: Response, next: () => void): void {
    if (!STARTUP_ASSET_RE.test(req.path)) {
        next();
        return;
    }

    const startedAt = Date.now();
    res.on('finish', () => {
        const totalMs = Date.now() - startedAt;
        const isShell = req.path === '/' || req.path === '/index.html';
        const shouldLog = isShell || res.statusCode >= 400 || totalMs >= STARTUP_ASSET_SLOW_MS;
        if (!shouldLog) return;
        console.log(`[asset] startup path=${req.path} status=${res.statusCode} ms=${totalMs} bytes=${res.getHeader('Content-Length') ?? 'unknown'} ua=${String(req.headers['user-agent'] ?? '').slice(0, 90)}`);
    });
    next();
}

export function createApp(
    coordinator: ProviderCoordinator | null,
): express.Express {
    const app = express();
    app.use(express.json());
    app.use(startupAssetLogger);

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
    app.use('/api', certRouter);
    app.use('/api', createCacheRouter(coordinator));
    app.use('/api', createSearchRouter(coordinator));
    app.use('/api', createCommentsRouter(coordinator));
    app.use('/api', providerFiltersRouter(coordinator));
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
