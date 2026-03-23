import { Router } from 'express';

const router = Router();

router.post('/log', (req, res) => {
    const { event, data } = req.body;
    if (!event || typeof event !== 'string') {
        return res.status(400).end();
    }
    console.log(`[Frontend] ${event}`, data ? JSON.stringify(data) : '');
    res.status(204).end();
});

export default router;
