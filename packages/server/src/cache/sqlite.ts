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

interface CacheJobRow {
  id: string;
  kind: string;
  resource_key: string;
  priority: number;
  payload_json: string;
  status: CacheJobStatus;
  run_after: number;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_until: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface ByteCacheRow {
  source_url: string;
  local_key: string;
  content_type: string | null;
  bytes: number | null;
  status: string;
  last_checked_at: number | null;
  updated_at: number;
  error: string | null;
}

type CacheJobStatus = 'queued' | 'running' | 'retry' | 'failed';

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

export interface CacheJobInput {
  kind: string;
  resourceKey: string;
  priority: number;
  payload: unknown;
  runAfter?: number;
  maxAttempts?: number;
  retryFailedAfterMs?: number;
}

export interface CacheJobRecord {
  id: string;
  kind: string;
  resourceKey: string;
  priority: number;
  payload: unknown;
  status: CacheJobStatus;
  runAfter: number;
  attempts: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseUntil: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export type CacheJobEnqueueResult = 'queued' | 'promoted' | 'requeued' | 'existing';

export interface ByteCacheRecord {
  sourceUrl: string;
  localKey: string;
  contentType: string | null;
  bytes: number | null;
  status: string;
  lastCheckedAt: number | null;
  updatedAt: number;
  error: string | null;
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

      CREATE TABLE IF NOT EXISTS cache_jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        resource_key TEXT NOT NULL,
        priority INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        run_after INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        lease_owner TEXT,
        lease_until INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(kind, resource_key)
      );

      CREATE INDEX IF NOT EXISTS idx_cache_jobs_claim
      ON cache_jobs(status, run_after, priority, created_at);

      CREATE INDEX IF NOT EXISTS idx_cache_jobs_lease
      ON cache_jobs(status, lease_until);

      CREATE TABLE IF NOT EXISTS byte_cache (
        source_url TEXT PRIMARY KEY,
        local_key TEXT NOT NULL,
        content_type TEXT,
        bytes INTEGER,
        status TEXT NOT NULL,
        last_checked_at INTEGER,
        updated_at INTEGER NOT NULL,
        error TEXT
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

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM cache_meta WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
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

  enqueueJob(input: CacheJobInput): CacheJobEnqueueResult {
    const now = Date.now();
    const id = `${input.kind}:${input.resourceKey}`;
    const runAfter = input.runAfter ?? now;
    const maxAttempts = input.maxAttempts ?? 3;
    const payloadJson = JSON.stringify(input.payload ?? {});

    return this.transaction(() => {
      const existing = this.db.prepare(`
        SELECT id, kind, resource_key, priority, payload_json, status, run_after, attempts, max_attempts,
          lease_owner, lease_until, last_error, created_at, updated_at
        FROM cache_jobs
        WHERE kind = ? AND resource_key = ?
      `).get(input.kind, input.resourceKey) as CacheJobRow | undefined;

      if (!existing) {
        this.db.prepare(`
          INSERT INTO cache_jobs (
            id, kind, resource_key, priority, payload_json, status, run_after, attempts,
            max_attempts, lease_owner, lease_until, last_error, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, ?, NULL, NULL, NULL, ?, ?)
        `).run(id, input.kind, input.resourceKey, input.priority, payloadJson, runAfter, maxAttempts, now, now);
        return 'queued';
      }

      if (existing.status === 'failed' && input.retryFailedAfterMs !== undefined && now - existing.updated_at >= input.retryFailedAfterMs) {
        this.db.prepare(`
          UPDATE cache_jobs
          SET priority = MAX(priority, ?),
            payload_json = ?,
            run_after = ?,
            attempts = 0,
            max_attempts = MAX(max_attempts, ?),
            status = 'queued',
            lease_owner = NULL,
            lease_until = NULL,
            last_error = NULL,
            updated_at = ?
          WHERE id = ?
        `).run(input.priority, payloadJson, runAfter, maxAttempts, now, existing.id);
        return 'requeued';
      }

      if (input.priority > existing.priority) {
        this.db.prepare(`
          UPDATE cache_jobs
          SET priority = ?,
            payload_json = ?,
            run_after = MIN(run_after, ?),
            max_attempts = MAX(max_attempts, ?),
            status = CASE WHEN status = 'failed' THEN 'queued' ELSE status END,
            last_error = CASE WHEN status = 'failed' THEN NULL ELSE last_error END,
            updated_at = ?
          WHERE id = ?
        `).run(input.priority, payloadJson, runAfter, maxAttempts, now, existing.id);
        return 'promoted';
      }

      return 'existing';
    });
  }

  claimNextJob(workerId: string, leaseMs: number, now = Date.now(), kinds?: string[]): CacheJobRecord | null {
    return this.transaction(() => {
      const kindFilter = kinds && kinds.length > 0
        ? `AND kind IN (${kinds.map(() => '?').join(', ')})`
        : '';
      const row = this.db.prepare(`
        SELECT id, kind, resource_key, priority, payload_json, status, run_after, attempts, max_attempts,
          lease_owner, lease_until, last_error, created_at, updated_at
        FROM cache_jobs
        WHERE (
          (status IN ('queued', 'retry') AND run_after <= ?)
          OR (status = 'running' AND lease_until IS NOT NULL AND lease_until < ?)
        )
        ${kindFilter}
        ORDER BY priority DESC, run_after ASC, created_at ASC
        LIMIT 1
      `).get(now, now, ...(kinds ?? [])) as CacheJobRow | undefined;

      if (!row) return null;

      const leaseUntil = now + leaseMs;
      this.db.prepare(`
        UPDATE cache_jobs
        SET status = 'running',
          attempts = attempts + 1,
          lease_owner = ?,
          lease_until = ?,
          updated_at = ?
        WHERE id = ?
      `).run(workerId, leaseUntil, now, row.id);

      return this.mapJobRow({
        ...row,
        status: 'running',
        attempts: row.attempts + 1,
        lease_owner: workerId,
        lease_until: leaseUntil,
        updated_at: now,
      });
    });
  }

  completeJob(id: string): void {
    this.db.prepare('DELETE FROM cache_jobs WHERE id = ?').run(id);
  }

  updateJobPriority(id: string, priority: number): void {
    this.db.prepare('UPDATE cache_jobs SET priority = ?, updated_at = ? WHERE id = ?').run(priority, Date.now(), id);
  }

  retryJob(id: string, error: string, runAfter: number): void {
    const now = Date.now();
    const row = this.db.prepare('SELECT attempts, max_attempts FROM cache_jobs WHERE id = ?').get(id) as { attempts: number; max_attempts: number } | undefined;
    if (!row) return;
    if (row.attempts >= row.max_attempts) {
      this.failJob(id, error);
      return;
    }
    this.db.prepare(`
      UPDATE cache_jobs
      SET status = 'retry',
        run_after = ?,
        lease_owner = NULL,
        lease_until = NULL,
        last_error = ?,
        updated_at = ?
      WHERE id = ?
    `).run(runAfter, error, now, id);
  }

  yieldJob(id: string, reason: string): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE cache_jobs
      SET status = 'queued',
        run_after = ?,
        lease_owner = NULL,
        lease_until = NULL,
        last_error = ?,
        updated_at = ?
      WHERE id = ?
    `).run(now, reason, now, id);
  }

  failJob(id: string, error: string): void {
    this.db.prepare(`
      UPDATE cache_jobs
      SET status = 'failed',
        lease_owner = NULL,
        lease_until = NULL,
        last_error = ?,
        updated_at = ?
      WHERE id = ?
    `).run(error, Date.now(), id);
  }

  recoverRunningJobsForOwner(workerId: string): number {
    const result = this.db.prepare(`
      UPDATE cache_jobs
      SET status = 'retry',
        run_after = ?,
        lease_owner = NULL,
        lease_until = NULL,
        updated_at = ?
      WHERE status = 'running' AND lease_owner = ?
    `).run(Date.now(), Date.now(), workerId);
    return Number(result.changes ?? 0);
  }

  cacheJobCounts(): Record<string, number> {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM cache_jobs
      GROUP BY status
    `).all() as unknown as Array<{ status: string; count: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) result[row.status] = row.count;
    return result;
  }

  getRunnableJobCountAbove(priority: number): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM cache_jobs
      WHERE status IN ('queued', 'retry')
        AND run_after <= ?
        AND priority > ?
    `).get(Date.now(), priority) as { count: number };
    return row.count;
  }

  getJobsForResource(kind: string, resourceKey: string): CacheJobRecord[] {
    const rows = this.db.prepare(`
      SELECT id, kind, resource_key, priority, payload_json, status, run_after, attempts, max_attempts,
        lease_owner, lease_until, last_error, created_at, updated_at
      FROM cache_jobs
      WHERE kind = ? AND resource_key = ?
      ORDER BY priority DESC, created_at ASC
    `).all(kind, resourceKey) as unknown as CacheJobRow[];
    return rows.map(row => this.mapJobRow(row));
  }

  getJobsByKinds(kinds: string[]): CacheJobRecord[] {
    if (kinds.length === 0) return [];
    const placeholders = kinds.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT id, kind, resource_key, priority, payload_json, status, run_after, attempts, max_attempts,
        lease_owner, lease_until, last_error, created_at, updated_at
      FROM cache_jobs
      WHERE kind IN (${placeholders})
      ORDER BY priority DESC, created_at ASC
    `).all(...kinds) as unknown as CacheJobRow[];
    return rows.map(row => this.mapJobRow(row));
  }

  getByteCache(sourceUrl: string): ByteCacheRecord | null {
    const row = this.db.prepare(`
      SELECT source_url, local_key, content_type, bytes, status, last_checked_at, updated_at, error
      FROM byte_cache
      WHERE source_url = ?
    `).get(sourceUrl) as ByteCacheRow | undefined;
    return row ? this.mapByteCacheRow(row) : null;
  }

  upsertByteCacheReady(sourceUrl: string, localKey: string, contentType: string, bytes: number): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO byte_cache (source_url, local_key, content_type, bytes, status, last_checked_at, updated_at, error)
      VALUES (?, ?, ?, ?, 'ready', ?, ?, NULL)
      ON CONFLICT(source_url) DO UPDATE SET
        local_key = excluded.local_key,
        content_type = excluded.content_type,
        bytes = excluded.bytes,
        status = excluded.status,
        last_checked_at = excluded.last_checked_at,
        updated_at = excluded.updated_at,
        error = NULL
    `).run(sourceUrl, localKey, contentType, bytes, now, now);
  }

  upsertByteCacheFailed(sourceUrl: string, localKey: string, error: string, status = 'failed'): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO byte_cache (source_url, local_key, content_type, bytes, status, last_checked_at, updated_at, error)
      VALUES (?, ?, NULL, NULL, ?, ?, ?, ?)
      ON CONFLICT(source_url) DO UPDATE SET
        local_key = excluded.local_key,
        status = excluded.status,
        last_checked_at = excluded.last_checked_at,
        updated_at = excluded.updated_at,
        error = excluded.error
    `).run(sourceUrl, localKey, status, now, now, error);
  }

  counts(): Record<string, number> {
    const tables = ['manga_cache', 'chapter_list_cache', 'chapter_image_cache', 'image_store_candidates', 'image_store_status', 'cache_jobs', 'byte_cache'] as const;
    const result: Record<string, number> = {};
    for (const table of tables) {
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
      result[table] = row.count;
    }
    return result;
  }

  private mapJobRow(row: CacheJobRow): CacheJobRecord {
    return {
      id: row.id,
      kind: row.kind,
      resourceKey: row.resource_key,
      priority: row.priority,
      payload: JSON.parse(row.payload_json),
      status: row.status,
      runAfter: row.run_after,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      leaseOwner: row.lease_owner,
      leaseUntil: row.lease_until,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapByteCacheRow(row: ByteCacheRow): ByteCacheRecord {
    return {
      sourceUrl: row.source_url,
      localKey: row.local_key,
      contentType: row.content_type,
      bytes: row.bytes,
      status: row.status,
      lastCheckedAt: row.last_checked_at,
      updatedAt: row.updated_at,
      error: row.error,
    };
  }
}
