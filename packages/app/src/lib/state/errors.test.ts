import { describe, it, expect } from 'vitest';
import { ErrorKind } from '../logic.js';
import { ApiErrKind } from '../services/fetchJson.js';
import { toLoadError, loadErrorMessage } from './errors.js';

describe('T-AZ-1: Error kinds map to user-facing messages', () => {
  it('upstream includes status code', () => {
    const msg = loadErrorMessage({ kind: ErrorKind.UPSTREAM, status: 404 });
    expect(msg).toContain('Server error');
    expect(msg).toContain('404');
  });

  it('timeout message', () => {
    const msg = loadErrorMessage({ kind: ErrorKind.TIMEOUT });
    expect(msg).toContain('timed out');
  });

  it('network message', () => {
    const msg = loadErrorMessage({ kind: ErrorKind.NETWORK });
    expect(msg).toContain('Network error');
  });

  it('cloudflare message', () => {
    const msg = loadErrorMessage({ kind: ErrorKind.CLOUDFLARE });
    expect(msg).toContain('Cloudflare');
  });
});

describe('T-AZ-1: toLoadError maps raw error to LoadError', () => {
  it('HTTP 404 → upstream with status', () => {
    const err = toLoadError({ kind: ApiErrKind.HTTP, status: 404 });
    expect(err.kind).toBe(ErrorKind.UPSTREAM);
    if (err.kind === ErrorKind.UPSTREAM) expect(err.status).toBe(404);
  });

  it('timeout → timeout', () => {
    const err = toLoadError({ kind: ApiErrKind.TIMEOUT });
    expect(err.kind).toBe(ErrorKind.TIMEOUT);
  });

  it('network → network', () => {
    const err = toLoadError({ kind: ApiErrKind.NETWORK });
    expect(err.kind).toBe(ErrorKind.NETWORK);
  });

  it('cloudflare → cloudflare', () => {
    const err = toLoadError({ kind: ApiErrKind.CLOUDFLARE, status: 503 });
    expect(err.kind).toBe(ErrorKind.CLOUDFLARE);
  });

  it('parse → network (catch-all)', () => {
    const err = toLoadError({ kind: ApiErrKind.PARSE });
    expect(err.kind).toBe(ErrorKind.NETWORK);
  });

  it('unknown error → network (catch-all)', () => {
    const err = toLoadError(new Error('something unexpected'));
    expect(err.kind).toBe(ErrorKind.NETWORK);
  });
});
