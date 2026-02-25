import { Readable } from 'node:stream';
import type { Response } from 'express';
import { COMIX_BASE_URL, CACHE_MAX_AGE, USER_AGENT } from '../config';
import { proxyFetch } from '../utils/proxyFetch';

/** No domain restriction — the backend is LAN-only and CDN domains change unpredictably. */
export function isAllowedImageDomain(_hostname: string): boolean {
  return true;
}

export async function streamImage(imageUrl: string, res: Response): Promise<void> {
  const r = await proxyFetch(imageUrl, {
    headers: {
      'Referer': COMIX_BASE_URL,
      'User-Agent': USER_AGENT,
    },
  });

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

  Readable.fromWeb(r.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
}
