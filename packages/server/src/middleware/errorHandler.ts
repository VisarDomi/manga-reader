import { Request, Response, NextFunction, RequestHandler } from 'express';
import { UpstreamError, CloudflareError, ParseError } from '../utils/proxyFetch';
import type { ProxyFetchMeta } from '../utils/proxyFetch';

type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

export function asyncHandler(fn: AsyncRequestHandler): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

function formatMeta(meta: ProxyFetchMeta): string {
  return `url=${meta.url} domain=${meta.domain} ${meta.durationMs}ms cf=${meta.cfCookiesInjected} ref=${meta.referer ?? 'none'}`;
}

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) return;

  if (err instanceof CloudflareError) {
    console.error(`[${req.path}] cloudflare ${formatMeta(err.meta)}`);
    res.status(503).set('X-Cloudflare-Solving', 'true').json({ error: 'cloudflare', solving: true });
  } else if (err instanceof UpstreamError) {
    console.error(`[${req.path}] upstream status=${err.status} ${formatMeta(err.meta)}`);
    res.status(err.status).json({ error: err.message, status: err.status });
  } else if (err instanceof ParseError) {
    console.error(`[${req.path}] parse-error upstream=${err.meta.status} ${formatMeta(err.meta)} cause=${(err.cause as Error)?.message ?? err.cause}`);
    res.status(502).json({ error: 'Failed to parse upstream response', status: 502 });
  } else {
    console.error(`[${req.path}] unexpected: ${err.stack || err.message}`);
    res.status(500).json({ error: 'Internal server error', status: 500 });
  }
}
