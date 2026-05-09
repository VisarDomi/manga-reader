import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CACHE_DB_PATH } from '../config.js';

interface MangaCacheRow {
  manga_id: string;
  data_json: string;
  updated_at: number;
}

interface ChapterListRow {
  manga_id: string;
  data_json: string;
  updated_at: number;
  status: string;
}

interface ChapterImageRow {
  manga_id: string;
  chapter_id: string;
  data_json: string;
  updated_at: number;
  status: string;
}

export interface CachedManga {
  mangaId: string;
  data: unknown;
  updatedAt: number;
}

export interface CachedChapterList {
  mangaId: string;
  data: unknown;
  updatedAt: number;
  status: string;
}

export interface CachedChapterImages {
  mangaId: string;
  chapterId: string;
  data: unknown;
  updatedAt: number;
  status: string;
}

export interface ImageStoreObservation {
  imageUrl: string;
  storeUrl: string;
  status: number;
  ok: boolean;
  source: 'frontend' | 'backend';
}

export class CacheDatabase {
  private db: DatabaseSync;

  constructor(dbPath = CACHE_DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS manga_cache (
        manga_id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chapter_list_cache (
        manga_id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS image_store_status (
        image_url TEXT NOT NULL,
        store_url TEXT NOT NULL,
        status INTEGER NOT NULL,
        ok INTEGER NOT NULL,
        source TEXT NOT NULL,
        last_checked_at INTEGER NOT NULL,
        PRIMARY KEY (image_url, store_url)
      );

      CREATE TABLE IF NOT EXISTS chapter_image_cache (
        manga_id TEXT NOT NULL,
        chapter_id TEXT NOT NULL,
        data_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        PRIMARY KEY (manga_id, chapter_id)
      );

      CREATE TABLE IF NOT EXISTS image_store_candidates (
        image_url TEXT NOT NULL,
        store_url TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        last_status INTEGER,
        last_ok INTEGER,
        PRIMARY KEY (image_url, store_url)
      );
    `);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  setMeta(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO cache_meta (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, Date.now());
  }

  upsertManga(mangaId: string, data: unknown): void {
    this.db.prepare(`
      INSERT INTO manga_cache (manga_id, data_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(manga_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at
    `).run(mangaId, JSON.stringify(data), Date.now());
  }

  getManga(mangaId: string): CachedManga | null {
    const row = this.db.prepare('SELECT manga_id, data_json, updated_at FROM manga_cache WHERE manga_id = ?')
      .get(mangaId) as MangaCacheRow | undefined;
    if (!row) return null;
    return { mangaId: row.manga_id, data: JSON.parse(row.data_json), updatedAt: row.updated_at };
  }

  upsertChapterList(mangaId: string, data: unknown, status = 'ready'): void {
    this.db.prepare(`
      INSERT INTO chapter_list_cache (manga_id, data_json, updated_at, status)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(manga_id) DO UPDATE SET
        data_json = excluded.data_json,
        updated_at = excluded.updated_at,
        status = excluded.status
    `).run(mangaId, JSON.stringify(data), Date.now(), status);
  }

  getChapterList(mangaId: string): CachedChapterList | null {
    const row = this.db.prepare('SELECT manga_id, data_json, updated_at, status FROM chapter_list_cache WHERE manga_id = ?')
      .get(mangaId) as ChapterListRow | undefined;
    if (!row) return null;
    return { mangaId: row.manga_id, data: JSON.parse(row.data_json), updatedAt: row.updated_at, status: row.status };
  }

  getAllChapterLists(): CachedChapterList[] {
    const rows = this.db.prepare('SELECT manga_id, data_json, updated_at, status FROM chapter_list_cache ORDER BY updated_at ASC')
      .all() as unknown as ChapterListRow[];
    return rows.map(row => ({
      mangaId: row.manga_id,
      data: JSON.parse(row.data_json),
      updatedAt: row.updated_at,
      status: row.status,
    }));
  }

  invalidateChapterList(mangaId: string): void {
    this.db.prepare('DELETE FROM chapter_list_cache WHERE manga_id = ?').run(mangaId);
  }

  observeImageStore(observation: ImageStoreObservation): void {
    this.db.prepare(`
      INSERT INTO image_store_status (image_url, store_url, status, ok, source, last_checked_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(image_url, store_url) DO UPDATE SET
        status = excluded.status,
        ok = excluded.ok,
        source = excluded.source,
        last_checked_at = excluded.last_checked_at
    `).run(
      observation.imageUrl,
      observation.storeUrl,
      observation.status,
      observation.ok ? 1 : 0,
      observation.source,
      Date.now(),
    );

    this.db.prepare(`
      INSERT INTO image_store_candidates (image_url, store_url, first_seen_at, last_seen_at, last_status, last_ok)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(image_url, store_url) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        last_status = excluded.last_status,
        last_ok = excluded.last_ok
    `).run(
      observation.imageUrl,
      observation.storeUrl,
      Date.now(),
      Date.now(),
      observation.status,
      observation.ok ? 1 : 0,
    );
  }

  upsertChapterImages(mangaId: string, chapterId: string, data: unknown, status = 'ready'): void {
    this.db.prepare(`
      INSERT INTO chapter_image_cache (manga_id, chapter_id, data_json, updated_at, status)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(manga_id, chapter_id) DO UPDATE SET
        data_json = excluded.data_json,
        updated_at = excluded.updated_at,
        status = excluded.status
    `).run(mangaId, chapterId, JSON.stringify(data), Date.now(), status);
  }

  getChapterImages(mangaId: string, chapterId: string): CachedChapterImages | null {
    const row = this.db.prepare('SELECT manga_id, chapter_id, data_json, updated_at, status FROM chapter_image_cache WHERE manga_id = ? AND chapter_id = ?')
      .get(mangaId, chapterId) as ChapterImageRow | undefined;
    if (!row) return null;
    return { mangaId: row.manga_id, chapterId: row.chapter_id, data: JSON.parse(row.data_json), updatedAt: row.updated_at, status: row.status };
  }

  observeImageCandidate(imageUrl: string, storeUrl: string): void {
    this.db.prepare(`
      INSERT INTO image_store_candidates (image_url, store_url, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(image_url, store_url) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `).run(imageUrl, storeUrl, Date.now(), Date.now());
  }

  counts(): Record<string, number> {
    const tables = ['manga_cache', 'chapter_list_cache', 'chapter_image_cache', 'image_store_candidates', 'image_store_status'] as const;
    const result: Record<string, number> = {};
    for (const table of tables) {
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
      result[table] = row.count;
    }
    return result;
  }
}
