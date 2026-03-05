type ApiErrorKind = 'network' | 'timeout' | 'http' | 'parse' | 'cloudflare';

export class ApiError extends Error {
    constructor(
        public readonly kind: ApiErrorKind,
        public readonly status?: number,
        cause?: unknown,
    ) {
        super(
            kind === 'http' ? `HTTP ${status}` :
            kind === 'timeout' ? 'Request timed out' :
            kind === 'parse' ? 'Invalid JSON response' :
            'Network error'
        );
        this.cause = cause;
    }
}

const TRANSIENT_CODES = new Set([408, 429, 500, 502, 503, 504]);

const FETCH_TIMEOUT_MS = 12_000;

interface FetchOptions {
    signal?: AbortSignal;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    retry?: boolean;
}

async function doFetch(url: string, opts: FetchOptions, parseResponse: (res: Response) => Promise<unknown>): Promise<unknown> {
    const { signal: callerSignal, method, headers, body, retry = false } = opts;
    let lastError: unknown;

    const maxAttempts = retry ? 2 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 1000));
        const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
        const signal = callerSignal
            ? AbortSignal.any([callerSignal, timeoutSignal])
            : timeoutSignal;
        try {
            const res = await fetch(url, { signal, method, headers, body });
            if (res.status === 503 && res.headers.get('X-Cloudflare-Solving') === 'true') {
                throw new ApiError('cloudflare', 503);
            }
            if (!res.ok) {
                const err = new ApiError('http', res.status);
                if (retry && TRANSIENT_CODES.has(res.status) && attempt < maxAttempts - 1) {
                    lastError = err;
                    continue;
                }
                throw err;
            }
            try {
                return await parseResponse(res);
            } catch (e) {
                if (e instanceof ApiError) throw e;
                throw new ApiError('parse', undefined, e);
            }
        } catch (e) {
            if (e instanceof ApiError) throw e;
            if (callerSignal?.aborted) throw e;
            if (e instanceof TypeError) {
                const err = new ApiError('network', undefined, e);
                if (retry && attempt < maxAttempts - 1) { lastError = err; continue; }
                throw err;
            }
            if (e instanceof DOMException && e.name === 'TimeoutError') {
                const err = new ApiError('timeout', undefined, e);
                if (retry && attempt < maxAttempts - 1) { lastError = err; continue; }
                throw err;
            }
            throw e;
        }
    }
    throw lastError;
}

export async function fetchJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
    return doFetch(url, opts, (res) => res.json()) as Promise<T>;
}

export async function fetchRaw(url: string, opts: FetchOptions = {}): Promise<string> {
    return doFetch(url, opts, (res) => res.text()) as Promise<string>;
}
