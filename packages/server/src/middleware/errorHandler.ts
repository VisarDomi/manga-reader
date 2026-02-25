import { Request, Response, NextFunction, RequestHandler } from 'express';
import { UpstreamError } from '../utils/proxyFetch';

type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

export function asyncHandler(fn: AsyncRequestHandler): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof UpstreamError) {
    console.error(`[${req.path}] Upstream error: ${err.message}`);
    res.status(err.status).json({ error: err.message, status: err.status });
  } else {
    console.error(`[${req.path}] Unexpected error:`, err.stack || err.message);
    res.status(500).json({ error: 'Internal server error', status: 500 });
  }
}
