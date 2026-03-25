import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Response } from 'express';
import { CACHE_MAX_AGE } from '../config';
import { proxyFetch } from '../utils/proxyFetch';
import type { ProxyFetchMeta } from '../utils/proxyFetch';

/** No domain restriction — the backend is LAN-only and CDN domains change unpredictably. */
export function isAllowedImageDomain(_hostname: string): boolean {
  return true;
}

// ── In-flight tracking ────────────────────────────────────────────────

let inFlight = 0;

// ── Logging ───────────────────────────────────────────────────────────

function logStreamResult(meta: ProxyFetchMeta, streamMs: number, totalMs: number, ok: boolean, errorMsg?: string): void {
  const size = meta.contentLength != null ? `${meta.contentLength}B` : '?B';
  const status = ok ? 'ok' : 'fail';
  console.log(
    `[imageProxy] ${status} ${meta.domain} ttfb=${meta.durationMs}ms stream=${streamMs}ms total=${totalMs}ms ${size} inflight=${inFlight} cf=${meta.cfCookiesInjected} ref=${meta.referer}${errorMsg ? ` err=${errorMsg}` : ''}`,
  );
}

// ── Stream lifecycle ──────────────────────────────────────────────────

export async function streamImage(imageUrl: string, res: Response, callerUA: string, referer?: string): Promise<void> {
  const headers: Record<string, string> = { 'User-Agent': callerUA };
  if (referer) headers['Referer'] = referer;

  inFlight++;
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
    inFlight--;
    throw new Error('Upstream returned empty body for image');
  }

  const readable = Readable.fromWeb(r.body as Parameters<typeof Readable.fromWeb>[0]);
  const streamStart = Date.now();

  try {
    await pipeline(readable, res);
    const now = Date.now();
    logStreamResult(meta, now - streamStart, now - requestStart, true);
  } catch (err) {
    const now = Date.now();
    logStreamResult(meta, now - streamStart, now - requestStart, false, (err as Error).message);
    if (!res.headersSent) res.status(502).end();
    else res.destroy();
  } finally {
    inFlight--;
  }
}
