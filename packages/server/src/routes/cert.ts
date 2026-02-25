import { Router, Request, Response } from 'express';
import fs from 'node:fs';
import { ROOT_CA_PATH } from '../config';

const router = Router();

router.get('/cert', (_req: Request, res: Response) => {
  if (fs.existsSync(ROOT_CA_PATH)) {
    res.setHeader('Content-Type', 'application/x-pem-file');
    res.sendFile(ROOT_CA_PATH);
  } else {
    res.status(404).json({ error: 'Root CA not found', status: 404 });
  }
});

export default router;
