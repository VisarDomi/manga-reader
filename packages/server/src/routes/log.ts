import { Router } from 'express';
import { learnStoreHostsFromUnknown } from '../utils/storeHosts.js';
import { FRONTEND_LOGS_ENABLED } from '../config.js';

const router = Router();

router.get('/log/config', (_req, res) => {
    res.json({ enabled: FRONTEND_LOGS_ENABLED });
});

router.post('/log', (req, res) => {
    if (!FRONTEND_LOGS_ENABLED) return res.status(204).end();

    const { event, data } = req.body;
    if (!event || typeof event !== 'string') {
        return res.status(400).end();
    }
    learnStoreHostsFromUnknown(data);
    console.log(`[Frontend] ${event}`, data ? JSON.stringify(data) : '');
    res.status(204).end();
});

export default router;
