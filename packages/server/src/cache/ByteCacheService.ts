import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Response } from 'express';
import { BYTE_CACHE_DIR, CACHE_MAX_AGE } from '../config.js';
import { proxyFetch } from '../utils/proxyFetch.js';
import { CacheDatabase, type CacheJobEnqueueResult } from './sqlite.js';
import { DurableJobScheduler, type CacheJobPriorityName } from './DurableJobScheduler.js';

const BYTE_CACHE_WORKER_ID = 'byte-cache-service';
const BYTE_CACHE_JOB_KIND = 'cache-byte';
const FAILED_BYTE_RETRY_MS = 60 * 60 * 1000;

export class ByteCacheService {
  private readonly db = new CacheDatabase();
  private readonly scheduler = new DurableJobScheduler(this.db);
  private active = false;
  private started = false;
  private currentJob: { sourceUrl: string; reason: string } | null = null;
  private summaryStartedAt = Date.now();
  private summaryLastLogAt = Date.now();
  private summaryJobs = 0;
  private summaryBytes = 0;
  private summarySkipped = 0;

  constructor(private readonly rootDir = BYTE_CACHE_DIR) {
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  close(): void {
    this.db.close();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduler.recoverWorker(BYTE_CACHE_WORKER_ID);
    this.drain();
    console.log('[byteCache] start');
  }

  warm(sourceUrl: string, referer: string | undefined, priority: CacheJobPriorityName, reason: string): CacheJobEnqueueResult {
    const status = this.scheduler.enqueueUnique({
      kind: BYTE_CACHE_JOB_KIND,
      resourceKey: sourceUrl,
      priority,
      payload: { sourceUrl, referer, reason },
      maxAttempts: 5,
      retryFailedAfterMs: priority === 'foreground' ? 0 : FAILED_BYTE_RETRY_MS,
    });
    this.drain();
    return status;
  }

  async stream(sourceUrl: string, res: Response, callerUA: string, referer?: string): Promise<void> {
    const localKey = this.localKey(sourceUrl);
    const finalPath = this.localPath(localKey);
    const cached = this.db.getByteCache(sourceUrl);

    if (cached?.status === 'ready' && fs.existsSync(finalPath)) {
      const contentType = cached.contentType || 'application/octet-stream';
      res.set('Content-Type', contentType);
      res.set('Cache-Control', `public, max-age=${CACHE_MAX_AGE}`);
      if (cached.bytes != null) res.set('Content-Length', String(cached.bytes));
      await pipeline(fs.createReadStream(finalPath), res);
      return;
    }

    await this.proxyAndStore(sourceUrl, localKey, finalPath, res, callerUA, referer);
  }

  private async proxyAndStore(sourceUrl: string, localKey: string, finalPath: string, res: Response, callerUA: string, referer?: string): Promise<void> {
    const start = Date.now();
    const headers: Record<string, string> = { 'User-Agent': callerUA };
    if (referer) headers.Referer = referer;

    try {
      const { response, meta } = await proxyFetch(sourceUrl, {
        headers,
        cloudflareProtected: true,
      });

      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      const buffer = Buffer.from(await response.arrayBuffer());
      this.writeAtomically(finalPath, buffer);
      this.db.upsertByteCacheReady(sourceUrl, localKey, contentType, buffer.byteLength);

      res.set('Content-Type', contentType);
      res.set('Cache-Control', `public, max-age=${CACHE_MAX_AGE}`);
      res.set('Content-Length', String(buffer.byteLength));
      res.send(buffer);

      console.log(`[byteCache] miss-store ok domain=${meta.domain} bytes=${buffer.byteLength} ttfbMs=${meta.durationMs} totalMs=${Date.now() - start}`);
    } catch (e) {
      const message = conciseError((e as Error)?.message ?? String(e));
      this.db.upsertByteCacheFailed(sourceUrl, localKey, message);
      console.log(`[byteCache] miss-store failed url=${sourceUrl} totalMs=${Date.now() - start} error=${message}`);
      if (!res.headersSent) res.status(502).json({ error: message, status: 502 });
      else res.destroy();
    }
  }

  private async cacheByte(sourceUrl: string, referer?: string): Promise<{ bytes: number; durationMs: number; skipped: boolean }> {
    const localKey = this.localKey(sourceUrl);
    const finalPath = this.localPath(localKey);
    const cached = this.db.getByteCache(sourceUrl);
    if (cached?.status === 'ready' && fs.existsSync(finalPath)) {
      return { bytes: cached.bytes ?? 0, durationMs: 0, skipped: true };
    }

    const start = Date.now();
    const headers: Record<string, string> = {};
    if (referer) headers.Referer = referer;

    try {
      const { response } = await proxyFetch(sourceUrl, {
        headers,
        cloudflareProtected: true,
      });
      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      const buffer = Buffer.from(await response.arrayBuffer());
      this.writeAtomically(finalPath, buffer);
      this.db.upsertByteCacheReady(sourceUrl, localKey, contentType, buffer.byteLength);
      return { bytes: buffer.byteLength, durationMs: Date.now() - start, skipped: false };
    } catch (e) {
      const message = conciseError((e as Error)?.message ?? String(e));
      this.db.upsertByteCacheFailed(sourceUrl, localKey, message);
      console.log(`[byteCache] job-store failed url=${sourceUrl} totalMs=${Date.now() - start} error=${message}`);
      throw e;
    }
  }

  private drain(): void {
    if (this.active) return;
    this.active = true;
    void this.runLoop().finally(() => {
      this.active = false;
      this.currentJob = null;
    });
  }

  private async runLoop(): Promise<void> {
    while (true) {
      const record = this.scheduler.claimNext(BYTE_CACHE_WORKER_ID, 10 * 60 * 1000, [BYTE_CACHE_JOB_KIND]);
      if (!record) return;
      const payload = payloadObject(record.payload);
      const sourceUrl = stringOrUndefined(payload.sourceUrl) ?? record.resourceKey;
      const referer = stringOrUndefined(payload.referer);
      const reason = stringOrUndefined(payload.reason) ?? 'durable-byte-job';
      this.currentJob = { sourceUrl, reason };
      try {
        const result = await this.cacheByte(sourceUrl, referer);
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
    if (this.summaryJobs < 100 && now - this.summaryLastLogAt < 30_000) return;
    console.log(`[byteCache] jobs-summary jobs=${this.summaryJobs} skipped=${this.summarySkipped} bytes=${this.summaryBytes} windowMs=${now - this.summaryStartedAt}`);
    this.summaryJobs = 0;
    this.summaryBytes = 0;
    this.summarySkipped = 0;
    this.summaryStartedAt = now;
    this.summaryLastLogAt = now;
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

function conciseError(error: string): string {
  return error.split('\n')[0]?.trim().slice(0, 500) || 'unknown-error';
}

function payloadObject(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
