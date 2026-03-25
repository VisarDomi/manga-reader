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

export interface ProxyFetchOptions extends RequestInit {
  cloudflareProtected?: boolean;
}

/** What proxyFetch resolved and observed — caller owns logging. */
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

export async function proxyFetch(
  url: string,
  init?: ProxyFetchOptions,
  timeout = PROXY_TIMEOUT,
): Promise<ProxyFetchResult> {
  const { cloudflareProtected, ...fetchInit } = init ?? {};
  const domain = new URL(url).hostname;
  const method = (fetchInit.method as string) ?? 'GET';

  // Track what we resolve for the caller
  let cfCookiesInjected = false;
  let resolvedUA: string | null = null;
  let resolvedReferer: string | null = null;

  // Inject cached CF cookies if available
  if (cloudflareProtected) {
    const cachedCookies = getCachedCookies(domain);
    if (cachedCookies) {
      const headers = new Headers(fetchInit.headers);
      headers.set('Cookie', cachedCookies);
      cfCookiesInjected = true;
      // CF binds cf_clearance to User-Agent — must match what the browser used
      const cachedUA = getCachedUserAgent(domain);
      if (cachedUA) {
        headers.set('User-Agent', cachedUA);
      }
      fetchInit.headers = Object.fromEntries(headers.entries());
    }
  }

  // Read resolved headers for meta
  const finalHeaders = new Headers(fetchInit.headers);
  resolvedUA = finalHeaders.get('user-agent');
  resolvedReferer = finalHeaders.get('referer');

  const start = Date.now();

  let r: globalThis.Response;
  try {
    r = await fetch(url, {
      ...fetchInit,
      signal: fetchInit.signal ?? AbortSignal.timeout(timeout),
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
    // If we had cached cookies and still got blocked, clear them
    if (getCachedCookies(domain)) {
      clearCachedCookies(domain);
    }

    if (isSolving(domain)) {
      throw new CloudflareError(`Cloudflare solve in progress for ${domain}`);
    }

    // Start solving in background
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
