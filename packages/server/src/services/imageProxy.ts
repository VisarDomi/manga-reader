import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Response } from 'express';
import { CACHE_MAX_AGE } from '../config.js';
import { proxyFetch } from '../utils/proxyFetch.js';
import type { ProxyFetchMeta } from '../utils/proxyFetch.js';

export function isAllowedImageDomain(_hostname: string): boolean {
  return true;
}
let inFlight = 0;

const FLUSH_DELAY_MS = 1000;

interface ImageBatch {
  count: number;
  totalBytes: number;
  ttfbSum: number;
  streamSum: number;
  totalMsSum: number;
  domain: string;
  peakInflight: number;
}

let batch: ImageBatch | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flushBatch(): void {
  if (!batch || batch.count === 0) { batch = null; return; }
  const avgTtfb = Math.round(batch.ttfbSum / batch.count);
  const avgStream = Math.round(batch.streamSum / batch.count);
  const avgTotal = Math.round(batch.totalMsSum / batch.count);
  const avgSize = Math.round(batch.totalBytes / batch.count);
  console.log(
    `[imageProxy] ok ${batch.domain} n=${batch.count} avgTtfb=${avgTtfb}ms avgStream=${avgStream}ms avgTotal=${avgTotal}ms avgSize=${avgSize}B peakInflight=${batch.peakInflight}`,
  );
  batch = null;
}

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { flushTimer = null; flushBatch(); }, FLUSH_DELAY_MS);
}

function recordSuccess(meta: ProxyFetchMeta, streamMs: number, totalMs: number): void {
  if (!batch) {
    batch = { count: 0, totalBytes: 0, ttfbSum: 0, streamSum: 0, totalMsSum: 0, domain: meta.domain, peakInflight: 0 };
  }
  batch.count++;
  batch.totalBytes += meta.contentLength ?? 0;
  batch.ttfbSum += meta.durationMs;
  batch.streamSum += streamMs;
  batch.totalMsSum += totalMs;
  if (inFlight > batch.peakInflight) batch.peakInflight = inFlight;
  scheduleFlush();
}

function logFailure(meta: ProxyFetchMeta, streamMs: number, totalMs: number, errorMsg: string): void {
  const size = meta.contentLength != null ? `${meta.contentLength}B` : '?B';
  console.log(
    `[imageProxy] fail ${meta.domain} ttfb=${meta.durationMs}ms stream=${streamMs}ms total=${totalMs}ms ${size} inflight=${inFlight} cf=${meta.cfCookiesInjected} ref=${meta.referer} err=${errorMsg}`,
  );
}
export async function streamImage(imageUrl: string, res: Response, callerUA: string, referer?: string): Promise<void> {
  const headers: Record<string, string> = { 'User-Agent': callerUA };
  if (referer) headers['Referer'] = referer;

  inFlight++;
  try {
    const requestStart = Date.now();

    const { response: r, meta } = await proxyFetch(imageUrl, { headers, cloudflareProtected: true });

    const contentType = r.headers.get('content-type') || 'image/jpeg';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', `public, max-age=${CACHE_MAX_AGE}`);

    const contentLength = r.headers.get('content-length');
    if (contentLength) {
      res.set('Content-Length', contentLength);
    }

    if (!r.body) {
      throw new Error('Upstream returned empty body for image');
    }

    const readable = Readable.fromWeb(r.body as Parameters<typeof Readable.fromWeb>[0]);
    const streamStart = Date.now();

    try {
      await pipeline(readable, res);
      const now = Date.now();
      recordSuccess(meta, now - streamStart, now - requestStart);
    } catch (err) {
      const now = Date.now();
      logFailure(meta, now - streamStart, now - requestStart, (err as Error).message);
      if (!res.headersSent) res.status(502).end();
      else res.destroy();
    }
  } finally {
    inFlight--;
  }
}
