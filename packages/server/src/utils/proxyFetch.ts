import { PROXY_TIMEOUT } from '../config';

export class UpstreamError extends Error {
  status: number;
  statusText: string;
  url: string;

  constructor(status: number, statusText: string, url: string) {
    super(`Upstream ${status} ${statusText} from ${url}`);
    this.name = 'UpstreamError';
    this.status = status;
    this.statusText = statusText;
    this.url = url;
  }
}

export async function proxyFetch(
  url: string,
  init?: RequestInit,
  timeout = PROXY_TIMEOUT,
) {
  const start = Date.now();
  const r = await fetch(url, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(timeout),
  });
  const duration = Date.now() - start;
  console.log(`[proxy] ${new URL(url).pathname} ${r.status} ${duration}ms`);

  if (!r.ok) {
    throw new UpstreamError(r.status, r.statusText, url);
  }
  return r;
}
