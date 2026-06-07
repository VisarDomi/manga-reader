import http from 'node:http';
import type { RequestHandler } from 'express';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function createSocketProxy(socketPath: string): RequestHandler {
  return (req, res) => {
    const startedAt = Date.now();
    const headers = { ...req.headers };
    for (const key of Object.keys(headers)) {
      if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) delete headers[key];
    }

    const upstream = http.request({
      socketPath,
      method: req.method,
      path: req.originalUrl,
      headers,
    }, (upstreamRes) => {
      res.statusCode = upstreamRes.statusCode ?? 502;
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase()) && value !== undefined) {
          res.setHeader(key, value);
        }
      }
      upstreamRes.pipe(res);
      upstreamRes.on('end', () => {
        const status = upstreamRes.statusCode ?? 0;
        if (status >= 400 || Date.now() - startedAt >= 1000) {
          console.log(`[apiProxy] path=${req.originalUrl} status=${status} ms=${Date.now() - startedAt}`);
        }
      });
    });

    upstream.on('error', (error) => {
      const message = String((error as Error)?.message ?? error);
      console.log(`[apiProxy] path=${req.originalUrl} status=502 ms=${Date.now() - startedAt} error=${message}`);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Worker unavailable', status: 502 });
      } else {
        res.destroy(error as Error);
      }
    });

    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  };
}
