import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Response } from 'express';
import { BYTE_CACHE_DIR, CACHE_MAX_AGE } from '../config.js';
import { proxyFetch } from '../utils/proxyFetch.js';
import { CacheDatabase, type CacheJobEnqueueResult, type MangaCoverVariant } from './sqlite.js';
import { CACHE_JOB_PRIORITY, DurableJobScheduler, type CacheJobPriorityName } from './DurableJobScheduler.js';
import type { RuntimeByteResult } from '../providers/types.js';

const BYTE_CACHE_WORKER_ID = 'byte-cache-service';
const BYTE_CACHE_JOB_KIND = 'cache-byte';
const FAILED_BYTE_RETRY_MS = 60 * 60 * 1000;

export class ByteCacheService {
  private readonly db: CacheDatabase;
  private readonly scheduler: DurableJobScheduler;
  private readonly ownsDb: boolean;
  private active = false;
  private started = false;
  private suspended = false;
  private currentJob: { sourceUrl: string; reason: string } | null = null;
  private summaryStartedAt = Date.now();
  private summaryLastLogAt = Date.now();
  private summaryJobs = 0;
  private summaryBytes = 0;
  private summarySkipped = 0;
  private backgroundPaused = false;
  private coverServeStartedAt = Date.now();
  private coverServeLastLogAt = Date.now();
  private coverServeHits = 0;
  private coverServeLinkedHits = 0;
  private coverServeMissStore = 0;
  private coverServeBytes = 0;
  private coverServeMaxMs = 0;

  constructor(
    private readonly rootDir = BYTE_CACHE_DIR,
    db?: CacheDatabase,
    private readonly ownerId = 'comix',
    private readonly runtimeByteFetcher?: (url: string, context: { owner?: string; priority?: string; reason?: string }) => Promise<RuntimeByteResult>,
    private canRunBackgroundByteWork: () => boolean = () => true,
  ) {
    this.db = db ?? new CacheDatabase();
    this.ownsDb = !db;
    this.scheduler = new DurableJobScheduler(this.db);
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  setCanRunBackgroundByteWork(canRun: () => boolean): void {
    this.canRunBackgroundByteWork = canRun;
    this.drain();
  }

  close(): void {
    this.suspend();
    if (this.ownsDb) this.db.close();
  }

  suspend(): void {
    this.suspended = true;
    this.started = false;
  }

  start(): void {
    this.suspended = false;
    if (this.started) return;
    this.started = true;
    this.scheduler.recoverWorker(BYTE_CACHE_WORKER_ID);
    this.drain();
    console.log(`[byteCache] start provider=${this.ownerId}`);
  }

  warmCover(mangaId: string, variant: MangaCoverVariant, sourceUrl: string, referer: string | undefined, priority: CacheJobPriorityName, reason: string): CacheJobEnqueueResult {
    this.db.upsertMangaCoverPending(mangaId, variant, sourceUrl);
    const isForeground = priority === 'interactive' || priority === 'foreground';
    const status = this.scheduler.enqueueUnique({
      kind: BYTE_CACHE_JOB_KIND,
      resourceKey: `cover:${mangaId}:${variant}`,
      priority,
      payload: { sourceUrl, referer, reason, mangaId, variant },
      maxAttempts: isForeground ? 3 : 1,
      retryFailedAfterMs: isForeground ? 0 : FAILED_BYTE_RETRY_MS,
    });
    this.drain();
    return status;
  }

  async streamCover(mangaId: string, variant: MangaCoverVariant, sourceUrl: string | undefined, res: Response, callerUA: string, referer?: string): Promise<void> {
    const owned = this.db.getMangaCover(mangaId, variant);
    const usableSourceUrl = sourceUrl || owned?.sourceUrl;
    if (!usableSourceUrl) {
      console.log(`[coverCache] unavailable provider=${this.ownerId} manga=${mangaId} variant=${variant} reason=no-source`);
      res.status(404).json({ error: 'Cover source unavailable', status: 404, mangaId, variant });
      return;
    }

    const localKey = this.localKey(usableSourceUrl);
    const finalPath = this.localPath(localKey);
    if (owned?.status === 'ready' && owned.localKey && fs.existsSync(this.localPath(owned.localKey))) {
      const start = Date.now();
      const contentType = owned.contentType || 'application/octet-stream';
      res.set('Content-Type', contentType);
      res.set('Cache-Control', `public, max-age=${CACHE_MAX_AGE}`);
      if (owned.bytes != null) res.set('Content-Length', String(owned.bytes));
      await pipeline(fs.createReadStream(this.localPath(owned.localKey)), res);
      this.recordCoverServe('hit', owned.bytes ?? 0, Date.now() - start);
      return;
    }

    const cached = this.db.getByteCache(usableSourceUrl);
    if (cached?.status === 'ready' && fs.existsSync(finalPath)) {
      const start = Date.now();
      const contentType = cached.contentType || 'application/octet-stream';
      this.db.upsertMangaCoverReady(mangaId, variant, usableSourceUrl, localKey, contentType, cached.bytes ?? 0);
      res.set('Content-Type', contentType);
      res.set('Cache-Control', `public, max-age=${CACHE_MAX_AGE}`);
      if (cached.bytes != null) res.set('Content-Length', String(cached.bytes));
      await pipeline(fs.createReadStream(finalPath), res);
      this.recordCoverServe('hit-linked', cached.bytes ?? 0, Date.now() - start);
      return;
    }

    await this.proxyAndStoreCover(mangaId, variant, usableSourceUrl, localKey, finalPath, res, callerUA, referer);
  }

  private async proxyAndStoreCover(mangaId: string, variant: MangaCoverVariant, sourceUrl: string, localKey: string, finalPath: string, res: Response, callerUA: string, referer?: string): Promise<void> {
    const start = Date.now();
    const headers: Record<string, string> = { 'User-Agent': callerUA };
    if (referer) headers.Referer = referer;

    try {
      const fetched = await this.fetchBytes(sourceUrl, headers, { owner: 'cover-cache', priority: 'foreground', reason: `stream-cover:${variant}` });
      const contentType = fetched.contentType;
      const buffer = fetched.buffer;
      this.writeAtomically(finalPath, buffer);
      this.db.upsertByteCacheReady(sourceUrl, localKey, contentType, buffer.byteLength);
      this.db.upsertMangaCoverReady(mangaId, variant, sourceUrl, localKey, contentType, buffer.byteLength);

      res.set('Content-Type', contentType);
      res.set('Cache-Control', `public, max-age=${CACHE_MAX_AGE}`);
      res.set('Content-Length', String(buffer.byteLength));
      res.send(buffer);

      this.recordCoverServe('miss-store', buffer.byteLength, Date.now() - start);
    } catch (e) {
      const message = conciseError((e as Error)?.message ?? String(e));
      this.db.upsertByteCacheFailed(sourceUrl, localKey, message);
      this.db.upsertMangaCoverFailed(mangaId, variant, sourceUrl, localKey, message);
      console.log(`[coverCache] miss-store failed provider=${this.ownerId} manga=${mangaId} variant=${variant} url=${sourceUrl} totalMs=${Date.now() - start} error=${message}`);
      if (!res.headersSent) res.status(502).json({ error: message, status: 502 });
      else res.destroy();
    }
  }

  private async cacheByte(sourceUrl: string, referer?: string, owner?: { mangaId: string; variant: MangaCoverVariant }): Promise<{ bytes: number; durationMs: number; skipped: boolean }> {
    const localKey = this.localKey(sourceUrl);
    const finalPath = this.localPath(localKey);
    const cached = this.db.getByteCache(sourceUrl);
    if (cached?.status === 'ready' && fs.existsSync(finalPath)) {
      if (owner) this.db.upsertMangaCoverReady(owner.mangaId, owner.variant, sourceUrl, localKey, cached.contentType || 'application/octet-stream', cached.bytes ?? 0);
      return { bytes: cached.bytes ?? 0, durationMs: 0, skipped: true };
    }

    const start = Date.now();
    const headers: Record<string, string> = {};
    if (referer) headers.Referer = referer;

    try {
      const fetched = await this.fetchBytes(sourceUrl, headers, { owner: 'byte-cache', priority: 'background', reason: owner ? `cover:${owner.variant}` : 'cache-byte' });
      const contentType = fetched.contentType;
      const buffer = fetched.buffer;
      this.writeAtomically(finalPath, buffer);
      this.db.upsertByteCacheReady(sourceUrl, localKey, contentType, buffer.byteLength);
      if (owner) this.db.upsertMangaCoverReady(owner.mangaId, owner.variant, sourceUrl, localKey, contentType, buffer.byteLength);
      return { bytes: buffer.byteLength, durationMs: Date.now() - start, skipped: false };
    } catch (e) {
      const message = conciseError((e as Error)?.message ?? String(e));
      this.db.upsertByteCacheFailed(sourceUrl, localKey, message);
      if (owner) this.db.upsertMangaCoverFailed(owner.mangaId, owner.variant, sourceUrl, localKey, message);
      console.log(`[byteCache] job-store failed provider=${this.ownerId} url=${sourceUrl} totalMs=${Date.now() - start} error=${message}`);
      throw e;
    }
  }

  private drain(): void {
    if (this.suspended) return;
    if (this.active) return;
    this.active = true;
    void this.runLoop().finally(() => {
      this.active = false;
      this.currentJob = null;
    });
  }

  private async fetchBytes(sourceUrl: string, headers: Record<string, string>, context: { owner?: string; priority?: string; reason?: string }): Promise<RuntimeByteResult> {
    if (this.runtimeByteFetcher) {
      return this.runtimeByteFetcher(sourceUrl, context);
    }
    const { response } = await proxyFetch(sourceUrl, {
      headers,
      cloudflareProtected: true,
    });
    return {
      status: response.status,
      contentType: response.headers.get('content-type') || 'application/octet-stream',
      buffer: Buffer.from(await response.arrayBuffer()),
    };
  }

  private async runLoop(): Promise<void> {
    while (true) {
      if (this.suspended) return;
      const runtimeAvailable = this.canRunBackgroundByteWork();
      if (!runtimeAvailable && !this.backgroundPaused) {
        this.backgroundPaused = true;
        console.log(`[byteCache] background-paused provider=${this.ownerId} reason=provider-runtime-owned-by-data`);
      } else if (runtimeAvailable && this.backgroundPaused) {
        this.backgroundPaused = false;
        console.log(`[byteCache] background-resumed provider=${this.ownerId}`);
      }
      const minPriority = runtimeAvailable ? undefined : CACHE_JOB_PRIORITY.foreground;
      const record = this.scheduler.claimNext(BYTE_CACHE_WORKER_ID, 10 * 60 * 1000, [BYTE_CACHE_JOB_KIND], minPriority);
      if (!record) return;
      const payload = payloadObject(record.payload);
      const sourceUrl = stringOrUndefined(payload.sourceUrl) ?? record.resourceKey;
      const referer = stringOrUndefined(payload.referer);
      const reason = stringOrUndefined(payload.reason) ?? 'durable-byte-job';
      const mangaId = stringOrUndefined(payload.mangaId);
      const variant = coverVariant(payload.variant);
      this.currentJob = { sourceUrl, reason };
      try {
        const result = await this.cacheByte(sourceUrl, referer, mangaId && variant ? { mangaId, variant } : undefined);
        this.recordSummary(result);
        this.scheduler.complete(record);
      } catch (e) {
        const message = conciseError((e as Error)?.message ?? String(e));
        this.scheduler.retry(record, message, this.retryDelayMs(record.attempts));
      }
    }
  }

  private recordSummary(result: { bytes: number; durationMs: number; skipped: boolean }): void {
    this.summaryJobs++;
    this.summaryBytes += result.bytes;
    if (result.skipped) this.summarySkipped++;
    const now = Date.now();
    const allSkipped = this.summarySkipped === this.summaryJobs;
    const jobThreshold = allSkipped ? 5000 : 100;
    if (this.summaryJobs < jobThreshold && now - this.summaryLastLogAt < 30_000) return;
    console.log(`[byteCache] jobs-summary provider=${this.ownerId} jobs=${this.summaryJobs} skipped=${this.summarySkipped} bytes=${this.summaryBytes} windowMs=${now - this.summaryStartedAt}`);
    this.summaryJobs = 0;
    this.summaryBytes = 0;
    this.summarySkipped = 0;
    this.summaryStartedAt = now;
    this.summaryLastLogAt = now;
  }

  private recordCoverServe(kind: 'hit' | 'hit-linked' | 'miss-store', bytes: number, durationMs: number): void {
    if (kind === 'hit') this.coverServeHits++;
    else if (kind === 'hit-linked') this.coverServeLinkedHits++;
    else this.coverServeMissStore++;
    this.coverServeBytes += bytes;
    this.coverServeMaxMs = Math.max(this.coverServeMaxMs, durationMs);
    const total = this.coverServeHits + this.coverServeLinkedHits + this.coverServeMissStore;
    const now = Date.now();
    if (total < 100 && now - this.coverServeLastLogAt < 30_000) return;
    console.log(`[coverCache] serve-summary provider=${this.ownerId} hits=${this.coverServeHits} linked=${this.coverServeLinkedHits} missStore=${this.coverServeMissStore} bytes=${this.coverServeBytes} maxMs=${Math.round(this.coverServeMaxMs)} windowMs=${now - this.coverServeStartedAt}`);
    this.coverServeHits = 0;
    this.coverServeLinkedHits = 0;
    this.coverServeMissStore = 0;
    this.coverServeBytes = 0;
    this.coverServeMaxMs = 0;
    this.coverServeStartedAt = now;
    this.coverServeLastLogAt = now;
  }

  private writeAtomically(finalPath: string, buffer: Buffer): void {
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, buffer);
    fs.renameSync(tmpPath, finalPath);
  }

  private localPath(localKey: string): string {
    return path.join(this.rootDir, localKey);
  }

  private localKey(sourceUrl: string): string {
    const hash = crypto.createHash('sha256').update(sourceUrl).digest('hex');
    const ext = this.extension(sourceUrl);
    return path.join(hash.slice(0, 2), `${hash}${ext}`);
  }

  private extension(sourceUrl: string): string {
    try {
      const ext = path.extname(new URL(sourceUrl).pathname).toLowerCase();
      return ext && ext.length <= 8 ? ext : '';
    } catch {
      return '';
    }
  }

  private retryDelayMs(attempts: number): number {
    return Math.min(60_000, 1000 * Math.max(1, attempts));
  }
}

function coverVariant(value: unknown): MangaCoverVariant | null {
  return value === 'card' || value === 'detail' ? value : null;
}

function conciseError(error: string): string {
  return error.split('\n')[0]?.trim().slice(0, 500) || 'unknown-error';
}

function payloadObject(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
