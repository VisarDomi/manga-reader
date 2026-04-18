import { Router } from 'express';
import { learnStoreHostsFromUnknown } from '../utils/storeHosts.js';

const router = Router();

router.post('/log', (req, res) => {
    const { event, data } = req.body;
    if (!event || typeof event !== 'string') {
        return res.status(400).end();
    }
    learnStoreHostsFromUnknown(data);
    console.log(`[Frontend] ${event}`, data ? JSON.stringify(data) : '');
    res.status(204).end();
});

export default router;
