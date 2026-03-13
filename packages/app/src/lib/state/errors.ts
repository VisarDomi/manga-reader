import { ApiError } from '../services/api.js';

// Rust-style: LoadError is a tagged union — each variant carries only its relevant data.
// The UI pattern-matches on `kind` to render the right message.
export type LoadError =
    | { kind: 'upstream'; status: number }
    | { kind: 'timeout' }
    | { kind: 'network' }
    | { kind: 'cloudflare' };

export function toLoadError(e: unknown): LoadError {
    if (e instanceof ApiError) {
        if (e.kind === 'cloudflare') return { kind: 'cloudflare' };
        if (e.kind === 'timeout') return { kind: 'timeout' };
        if (e.kind === 'http') return { kind: 'upstream', status: e.status ?? 0 };
    }
    return { kind: 'network' };
}

export function loadErrorMessage(err: LoadError): string {
    switch (err.kind) {
        case 'upstream': return `Server error (${err.status}) — try again later`;
        case 'timeout': return 'Request timed out — try again later';
        case 'cloudflare': return 'Blocked by Cloudflare — retrying...';
        case 'network': return 'Network error — check your connection';
        default: { const _: never = err; return _; }
    }
}
