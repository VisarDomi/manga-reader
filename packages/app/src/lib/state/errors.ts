import { ApiError, ApiErrKind } from '../services/fetchJson.js';

export type LoadError =
    | { kind: 'upstream'; status: number }
    | { kind: 'timeout' }
    | { kind: 'network' }
    | { kind: 'cloudflare' };

const LoadErrKind = {
    UPSTREAM: 'upstream',
    TIMEOUT: 'timeout',
    NETWORK: 'network',
    CLOUDFLARE: 'cloudflare',
} as const;

export function toLoadError(e: unknown): LoadError {
    if (e instanceof ApiError) {
        if (e.kind === ApiErrKind.CLOUDFLARE) return { kind: LoadErrKind.CLOUDFLARE };
        if (e.kind === ApiErrKind.TIMEOUT) return { kind: LoadErrKind.TIMEOUT };
        if (e.kind === ApiErrKind.HTTP) return { kind: LoadErrKind.UPSTREAM, status: e.status ?? 0 };
    }
    return { kind: LoadErrKind.NETWORK };
}

export function loadErrorMessage(err: LoadError): string {
    switch (err.kind) {
        case LoadErrKind.UPSTREAM: return `Server error (${err.status}) — try again later`;
        case LoadErrKind.TIMEOUT: return 'Request timed out — try again later';
        case LoadErrKind.CLOUDFLARE: return 'Blocked by Cloudflare — retrying...';
        case LoadErrKind.NETWORK: return 'Network error — check your connection';
        default: { const _: never = err; return _; }
    }
}
