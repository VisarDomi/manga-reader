import { describe, it, expect } from 'vitest';
import { ApiError, ApiErrKind } from '../services/fetchJson.js';
import { toLoadError, loadErrorMessage } from './errors.js';

describe('toLoadError: maps ApiError to LoadError', () => {
  it('maps CLOUDFLARE to cloudflare', () => {
    const err = toLoadError(new ApiError(ApiErrKind.CLOUDFLARE, 503));
    expect(err.kind).toBe('cloudflare');
  });

  it('maps TIMEOUT to timeout', () => {
    const err = toLoadError(new ApiError(ApiErrKind.TIMEOUT));
    expect(err.kind).toBe('timeout');
  });

  it('maps HTTP to upstream with status', () => {
    const err = toLoadError(new ApiError(ApiErrKind.HTTP, 404));
    expect(err.kind).toBe('upstream');
    if (err.kind === 'upstream') {
      expect(err.status).toBe(404);
    }
  });

  it('maps NETWORK to network', () => {
    const err = toLoadError(new ApiError(ApiErrKind.NETWORK));
    expect(err.kind).toBe('network');
  });

  it('maps PARSE to network (catch-all)', () => {
    const err = toLoadError(new ApiError(ApiErrKind.PARSE));
    expect(err.kind).toBe('network');
  });

  it('maps unknown errors to network', () => {
    const err = toLoadError(new Error('something'));
    expect(err.kind).toBe('network');
  });
});

describe('loadErrorMessage: user-facing messages', () => {
  it('upstream includes status code', () => {
    const msg = loadErrorMessage({ kind: 'upstream', status: 500 });
    expect(msg).toContain('500');
    expect(msg).toContain('Server error');
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
