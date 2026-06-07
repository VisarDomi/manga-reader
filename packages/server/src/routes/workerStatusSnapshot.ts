import { Router } from 'express';
import path from 'node:path';
import { STATE_DIR } from '../config.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { readWorkerStatusSnapshot } from '../services/WorkerStatusSnapshot.js';

function providerIdFromQuery(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : 'comix';
}

function cacheDbPath(providerId: string): string {
  return providerId === 'comix'
    ? path.join(STATE_DIR, 'cache.sqlite')
    : path.join(STATE_DIR, `cache-${providerId}.sqlite`);
}

export default function workerStatusSnapshotRouter(): Router {
  const router = Router();

  router.get('/providers', asyncHandler(async (_req, res) => {
    const snapshot = readWorkerStatusSnapshot();
    if (!snapshot) {
      res.status(503).json({ error: 'Worker status unavailable', status: 503 });
      return;
    }
    res.json({
      status: 'ok',
      result: snapshot.providers,
      meta: {
        source: 'worker-snapshot',
        ageMs: Date.now() - snapshot.updatedAt,
      },
    });
  }));

  router.get('/cache/status', asyncHandler(async (req, res, next) => {
    const snapshot = readWorkerStatusSnapshot();
    if (!snapshot) {
      res.status(503).json({ error: 'Worker status unavailable', status: 503 });
      return;
    }
    const providerId = providerIdFromQuery(req.query.providerId);
    const status = snapshot.cache[providerId];
    if (req.query.full === 'true') {
      const startedAt = Date.now();
      const { CacheDatabase } = await import('../cache/sqlite.js');
      const db = new CacheDatabase(cacheDbPath(providerId));
      try {
        res.json({
          ...(status ?? { started: false, providerId, active: false, activeLanes: [], currentJobs: {} }),
          durableJobs: db.cacheJobCounts(),
          counts: db.counts(),
          meta: {
            source: 'public-sqlite-diagnostic',
            snapshotAgeMs: Date.now() - snapshot.updatedAt,
            queryMs: Date.now() - startedAt,
          },
        });
      } finally {
        db.close();
      }
      return;
    }
    if (!status) {
      res.json({ providers: snapshot.providers, meta: { source: 'worker-snapshot', ageMs: Date.now() - snapshot.updatedAt } });
      return;
    }
    res.json({
      ...status,
      meta: {
        source: 'worker-snapshot',
        ageMs: Date.now() - snapshot.updatedAt,
      },
    });
  }));

  return router;
}
