import { describe, it, expect } from 'vitest';
import { ApiError, ApiErrKind } from '../services/fetchJson.js';
import { toLoadError, loadErrorMessage } from './errors.js';

describe('T-AZ-1: Error kinds map to user-facing messages', () => {
  it('upstream includes status code', () => {
    const msg = loadErrorMessage({ kind: 'upstream', status: 404 });
    expect(msg).toContain('Server error');
    expect(msg).toContain('404');
  });

  it('timeout message', () => {
    const msg = loadErrorMessage({ kind: 'timeout' });
    expect(msg).toContain('timed out');
  });

  it('network message', () => {
    const msg = loadErrorMessage({ kind: 'network' });
    expect(msg).toContain('Network error');
  });

  it('cloudflare message', () => {
    const msg = loadErrorMessage({ kind: 'cloudflare' });
    expect(msg).toContain('Cloudflare');
  });
});

describe('T-AZ-1: toLoadError maps ApiError to LoadError', () => {
  it('HTTP 404 → upstream with status', () => {
    const err = toLoadError(new ApiError(ApiErrKind.HTTP, 404));
    expect(err.kind).toBe('upstream');
    if (err.kind === 'upstream') expect(err.status).toBe(404);
  });

  it('TIMEOUT → timeout', () => {
    const err = toLoadError(new ApiError(ApiErrKind.TIMEOUT));
    expect(err.kind).toBe('timeout');
  });

  it('NETWORK → network', () => {
    const err = toLoadError(new ApiError(ApiErrKind.NETWORK));
    expect(err.kind).toBe('network');
  });

  it('CLOUDFLARE → cloudflare', () => {
    const err = toLoadError(new ApiError(ApiErrKind.CLOUDFLARE, 503));
    expect(err.kind).toBe('cloudflare');
  });

  it('PARSE → network (catch-all)', () => {
    const err = toLoadError(new ApiError(ApiErrKind.PARSE));
    expect(err.kind).toBe('network');
  });

  it('unknown error → network (catch-all)', () => {
    const err = toLoadError(new Error('something unexpected'));
    expect(err.kind).toBe('network');
  });
});
