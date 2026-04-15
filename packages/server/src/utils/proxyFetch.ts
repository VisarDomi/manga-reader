import { PROXY_TIMEOUT } from '../config.js';
import { isCloudflareBlock, getCachedCookies, getCachedUserAgent, clearCachedCookies, isSolving, solveCloudflareCookies } from './cloudflare.js';

export interface ProxyFetchMeta {
  url: string;
  method: string;
  domain: string;
  resolvedUA: string | null;
  referer: string | null;
  cfCookiesInjected: boolean;
  status: number;
  durationMs: number;
  contentLength: number | null;
}

export class UpstreamError extends Error {
  status: number;
  statusText: string;
  meta: ProxyFetchMeta;

  constructor(status: number, statusText: string, meta: ProxyFetchMeta) {
    super(`Upstream ${status} ${statusText} from ${meta.url}`);
    this.name = 'UpstreamError';
    this.status = status;
    this.statusText = statusText;
    this.meta = meta;
  }
}

export class CloudflareError extends Error {
  meta: ProxyFetchMeta;

  constructor(meta: ProxyFetchMeta) {
    super(`Cloudflare block for ${meta.domain}`);
    this.name = 'CloudflareError';
    this.meta = meta;
  }
}

export interface ResolvedHeaders {
  headers: Record<string, string>;
  cfCookiesInjected: boolean;
}

export function resolveHeaders(
  callerHeaders: Record<string, string>,
  domain: string,
): ResolvedHeaders {
  const cfCookies = getCachedCookies(domain);
  if (!cfCookies) {
    return { headers: { ...callerHeaders }, cfCookiesInjected: false };
  }

  const resolved: Record<string, string> = { ...callerHeaders, Cookie: cfCookies };
  const cfUA = getCachedUserAgent(domain);
  if (cfUA) {
    resolved['User-Agent'] = cfUA;
  }
  return { headers: resolved, cfCookiesInjected: true };
}

export interface ProxyFetchResult {
  response: globalThis.Response;
  meta: ProxyFetchMeta;
}

export interface ProxyFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  cloudflareProtected?: boolean;
}

export async function proxyFetch(
  url: string,
  init?: ProxyFetchOptions,
  timeout = PROXY_TIMEOUT,
): Promise<ProxyFetchResult> {
  const { cloudflareProtected, headers: callerHeaders, ...fetchOpts } = init ?? {};
  const domain = new URL(url).hostname;
  const method = fetchOpts.method ?? 'GET';

  const { headers, cfCookiesInjected } = cloudflareProtected
    ? resolveHeaders(callerHeaders ?? {}, domain)
    : { headers: { ...callerHeaders }, cfCookiesInjected: false };

  const resolvedUA = headers['User-Agent'] ?? null;
  const resolvedReferer = headers['Referer'] ?? null;

  const start = Date.now();

  let r: globalThis.Response;
  try {
    r = await fetch(url, {
      method,
      headers,
      body: fetchOpts.body,
      signal: fetchOpts.signal ?? AbortSignal.timeout(timeout),
    });
  } catch (e) {
    const durationMs = Date.now() - start;
    const kind = e instanceof DOMException && e.name === 'TimeoutError' ? 'timeout' : 'fetch-error';
    console.error(`[proxyFetch] ${kind} ${method} ${url} ${durationMs}ms ua=${resolvedUA} referer=${resolvedReferer} cf=${cfCookiesInjected}`);
    throw e;
  }

  const durationMs = Date.now() - start;
  const meta: ProxyFetchMeta = {
    url,
    method,
    domain,
    resolvedUA,
    referer: resolvedReferer,
    cfCookiesInjected,
    status: r.status,
    durationMs,
    contentLength: r.headers.get('content-length') ? parseInt(r.headers.get('content-length')!, 10) : null,
  };

  if (!r.ok && cloudflareProtected && isCloudflareBlock(r.status, r.headers.get('server'))) {
    if (cfCookiesInjected) {
      clearCachedCookies(domain);
    }

    if (!isSolving(domain)) {
      solveCloudflareCookies(url).catch(err => {
        console.error(`[cloudflare] Solve failed for ${domain}:`, err.message);
      });
    }

    throw new CloudflareError(meta);
  }

  if (!r.ok) {
    throw new UpstreamError(r.status, r.statusText, meta);
  }
  return { response: r, meta };
}

export class ParseError extends Error {
  meta: ProxyFetchMeta;

  constructor(meta: ProxyFetchMeta, cause: unknown) {
    super(`Failed to parse ${meta.method} ${meta.url}`);
    this.name = 'ParseError';
    this.meta = meta;
    this.cause = cause;
  }
}

export interface ConsumedResult<T> {
  data: T;
  meta: ProxyFetchMeta;
}

export async function proxyFetchJson<T = unknown>(
  url: string,
  init?: ProxyFetchOptions,
  timeout?: number,
): Promise<ConsumedResult<T>> {
  const { response, meta } = await proxyFetch(url, init, timeout);
  try {
    const data = await response.json() as T;
    return { data, meta };
  } catch (e) {
    throw new ParseError(meta, e);
  }
}

export async function proxyFetchText(
  url: string,
  init?: ProxyFetchOptions,
  timeout?: number,
): Promise<ConsumedResult<string>> {
  const { response, meta } = await proxyFetch(url, init, timeout);
  try {
    const data = await response.text();
    return { data, meta };
  } catch (e) {
    throw new ParseError(meta, e);
  }
}
