import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { STATE_DIR } from '../config.js';
import { asyncHandler } from '../middleware/errorHandler.js';

interface FavoriteBackupRow {
  providerId: string;
  id: string;
  snapshot?: {
    title: string;
    cover: string;
    latestChapter: number | null;
  };
}

interface FavoritesBackupPayload {
  version: 1;
  savedAt: string;
  favorites: FavoriteBackupRow[];
}

const BACKUP_PATH = path.join(STATE_DIR, 'favorites-backup.json');

function backupRow(value: unknown): FavoriteBackupRow | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const providerId = typeof record.providerId === 'string' ? record.providerId : '';
  const id = typeof record.id === 'string' ? record.id : '';
  if (!providerId || !id) return null;
  const snapshotValue = record.snapshot;
  let snapshot: FavoriteBackupRow['snapshot'];
  if (snapshotValue && typeof snapshotValue === 'object') {
    const raw = snapshotValue as Record<string, unknown>;
    snapshot = {
      title: typeof raw.title === 'string' ? raw.title : id,
      cover: typeof raw.cover === 'string' ? raw.cover : '',
      latestChapter: typeof raw.latestChapter === 'number' ? raw.latestChapter : null,
    };
  }
  return snapshot ? { providerId, id, snapshot } : { providerId, id };
}

function readBackup(): FavoritesBackupPayload | null {
  if (!fs.existsSync(BACKUP_PATH)) return null;
  const parsed = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8')) as FavoritesBackupPayload;
  if (parsed.version !== 1 || !Array.isArray(parsed.favorites)) return null;
  return parsed;
}

function writeBackup(payload: FavoritesBackupPayload): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${BACKUP_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(tmp, BACKUP_PATH);
}

const router = Router();

router.get('/favorites-backup', asyncHandler(async (_req, res) => {
  const backup = readBackup();
  if (!backup) {
    res.status(404).json({ error: 'No favorites backup found', status: 404 });
    return;
  }
  res.json(backup);
}));

router.post('/favorites-backup', asyncHandler(async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const rows = Array.isArray(body.favorites)
    ? body.favorites.map(backupRow).filter((row): row is FavoriteBackupRow => row != null)
    : [];
  const payload: FavoritesBackupPayload = {
    version: 1,
    savedAt: new Date().toISOString(),
    favorites: rows,
  };
  writeBackup(payload);
  console.log(`[favoritesBackup] saved rows=${rows.length} providers=${[...new Set(rows.map(row => row.providerId))].join(',')}`);
  res.json(payload);
}));

export default router;
