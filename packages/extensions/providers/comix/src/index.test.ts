import { describe, it, expect } from 'vitest';
import provider from './index.js';

describe('T-C1-1: Search limit is 100', () => {
  it('search request uses limit=100', () => {
    const req = provider.searchRequest('test', 1);
    const url = new URL(req.url);
    expect(url.searchParams.get('limit')).toBe('100');
  });
});
