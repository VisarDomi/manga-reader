import { PROXY_TIMEOUT } from '../config';
import { isCloudflareBlock, getCachedCookies, getCachedUserAgent, clearCachedCookies, isSolving, solveCloudflareCookies } from './cloudflare';

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

export class CloudflareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudflareError';
  }
}

// ── Header resolution (pure) ──────────────────────────────────────────

export interface ResolvedHeaders {
  headers: Record<string, string>;
  cfCookiesInjected: boolean;
}

/**
 * Pure function: merges caller headers with CF cookies/UA for a domain.
 * Returns a new object — caller headers are never mutated.
 * The caller sees exactly what will be sent before the fetch happens.
 */
export function resolveHeaders(
  callerHeaders: Record<string, string>,
  domain: string,
): ResolvedHeaders {
  const cfCookies = getCachedCookies(domain);
  if (!cfCookies) {
    return { headers: { ...callerHeaders }, cfCookiesInjected: false };
  }

  const resolved: Record<string, string> = { ...callerHeaders, Cookie: cfCookies };
  // CF binds cf_clearance to User-Agent — must match what the browser used
  const cfUA = getCachedUserAgent(domain);
  if (cfUA) {
    resolved['User-Agent'] = cfUA;
  }
  return { headers: resolved, cfCookiesInjected: true };
}

// ── Fetch metadata (caller owns logging) ──────────────────────────────

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

export interface ProxyFetchResult {
  response: globalThis.Response;
  meta: ProxyFetchMeta;
}

// ── Fetch execution ───────────────────────────────────────────────────

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

  // Phase 1: resolve headers — pure, no side effects
  const { headers, cfCookiesInjected } = cloudflareProtected
    ? resolveHeaders(callerHeaders ?? {}, domain)
    : { headers: { ...callerHeaders }, cfCookiesInjected: false };

  const resolvedUA = headers['User-Agent'] ?? null;
  const resolvedReferer = headers['Referer'] ?? null;

  // Phase 2: execute fetch
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

  // Phase 3: CF error detection + recovery
  if (!r.ok && cloudflareProtected && isCloudflareBlock(r.status, r.headers.get('server'))) {
    if (cfCookiesInjected) {
      clearCachedCookies(domain);
    }

    if (isSolving(domain)) {
      throw new CloudflareError(`Cloudflare solve in progress for ${domain}`);
    }

    solveCloudflareCookies(url).catch(err => {
      console.error(`[cloudflare] Solve failed for ${domain}:`, err.message);
    });

    throw new CloudflareError(`Cloudflare block detected for ${domain}, solving started`);
  }

  if (!r.ok) {
    throw new UpstreamError(r.status, r.statusText, url);
  }
  return { response: r, meta };
}
