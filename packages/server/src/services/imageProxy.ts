import { Readable } from 'node:stream';
import type { Response } from 'express';
import { CACHE_MAX_AGE } from '../config';
import { proxyFetch } from '../utils/proxyFetch';
import type { ProxyFetchMeta } from '../utils/proxyFetch';

/** No domain restriction — the backend is LAN-only and CDN domains change unpredictably. */
export function isAllowedImageDomain(_hostname: string): boolean {
  return true;
}

function logImageRequest(meta: ProxyFetchMeta): void {
  const size = meta.contentLength != null ? `${meta.contentLength}B` : '?B';
  console.log(
    `[imageProxy] ${meta.status} ${meta.domain} ${meta.durationMs}ms ${size} cf=${meta.cfCookiesInjected} ua=${meta.resolvedUA} ref=${meta.referer}`,
  );
}

export async function streamImage(imageUrl: string, res: Response, callerUA: string, referer?: string): Promise<void> {
  const headers: Record<string, string> = { 'User-Agent': callerUA };
  if (referer) headers['Referer'] = referer;

  const { response: r, meta } = await proxyFetch(imageUrl, { headers, cloudflareProtected: true });
  logImageRequest(meta);

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
  readable.on('error', (err) => {
    console.error(`[imageProxy] stream error for ${imageUrl}: ${err.message}`);
    if (!res.headersSent) res.status(502).end();
    else res.destroy();
  });
  readable.pipe(res);
}
