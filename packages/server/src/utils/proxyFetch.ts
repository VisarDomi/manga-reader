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

export async function proxyFetch(
  url: string,
  init?: ProxyFetchOptions,
  timeout = PROXY_TIMEOUT,
) {
  const { cloudflareProtected, ...fetchInit } = init ?? {};
  const domain = new URL(url).hostname;

  // Inject cached CF cookies if available
  if (cloudflareProtected) {
    const cachedCookies = getCachedCookies(domain);
    if (cachedCookies) {
      const headers = new Headers(fetchInit.headers);
      headers.set('Cookie', cachedCookies);
      // CF binds cf_clearance to User-Agent — must match what the browser used
      const cachedUA = getCachedUserAgent(domain);
      if (cachedUA) {
        headers.set('User-Agent', cachedUA);
      }
      fetchInit.headers = Object.fromEntries(headers.entries());
    }
  }

  let r: globalThis.Response;
  try {
    r = await fetch(url, {
      ...fetchInit,
      signal: fetchInit.signal ?? AbortSignal.timeout(timeout),
    });
  } catch (e) {
    const kind = e instanceof DOMException && e.name === 'TimeoutError' ? 'timeout' : 'fetch-error';
    console.error(`[proxyFetch] ${kind} ${fetchInit.method ?? 'GET'} ${url}: ${(e as Error).message}`);
    throw e;
  }

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
  return r;
}
