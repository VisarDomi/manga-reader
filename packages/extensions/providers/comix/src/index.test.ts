import { describe, it, expect } from 'vitest';
import provider from './index.js';
import { computeHasMore } from './pagination.js';

// ── Search Page Size ───────────────────────────────────────────────────

describe('T-C1-1: Search limit is 100', () => {
  it('search request uses limit=100', () => {
    const req = provider.searchRequest('test', 1);
    const url = new URL(req.url);
    expect(url.searchParams.get('limit')).toBe('100');
  });
});

describe('T-C1-2: Chapter list limit is 100', () => {
  it('chapter list request uses limit=100', () => {
    const req = provider.chapterListRequest('test-manga', 1);
    const url = new URL(req.url);
    expect(url.searchParams.get('limit')).toBe('100');
  });
});

// ── hasMore Computation ────────────────────────────────────────────────

describe('T-C2-1: hasMore = current_page < last_page', () => {
  it('returns true when current_page < last_page', () => {
    expect(computeHasMore({ current_page: 1, last_page: 3 })).toBe(true);
  });

  it('returns false when current_page === last_page', () => {
    expect(computeHasMore({ current_page: 3, last_page: 3 })).toBe(false);
  });
});

describe('T-C2-2: No extra request when total is multiple of 100', () => {
  it('returns false — no trailing empty request', () => {
    expect(computeHasMore({ current_page: 3, last_page: 3 })).toBe(false);
  });
});

// ── Sort Order ─────────────────────────────────────────────────────────

describe('T-C3-1: No keyword — sort by chapter_updated_at desc', () => {
  it('empty query includes sort param', () => {
    const req = provider.searchRequest('', 1);
    const url = new URL(req.url);
    expect(url.searchParams.get('order[chapter_updated_at]')).toBe('desc');
  });
});

describe('T-C3-2: With keyword — no explicit sort', () => {
  it('keyword query has no sort param', () => {
    const req = provider.searchRequest('one piece', 1);
    const url = new URL(req.url);
    expect(url.searchParams.has('order[chapter_updated_at]')).toBe(false);
  });
});

// ── NSFW Genres ────────────────────────────────────────────────────────

describe('T-C4-1: Exactly 5 NSFW genres', () => {
  it('getFilters returns exactly 5 genres with nsfw === true', () => {
    const filters = provider.getFilters();
    const nsfwGenres = filters.genres.filter(
      (g) => 'nsfw' in g && (g as { nsfw?: boolean }).nsfw === true,
    );
    expect(nsfwGenres).toHaveLength(5);
    expect(nsfwGenres.map(g => g.name).sort()).toEqual(
      ['Adult', 'Ecchi', 'Hentai', 'Mature', 'Smut'],
    );
  });
});

describe('T-C4-2: NSFW flag on genre options', () => {
  it('each NSFW genre has nsfw: true', () => {
    const filters = provider.getFilters();
    const nsfwNames = ['Adult', 'Ecchi', 'Hentai', 'Mature', 'Smut'];
    for (const name of nsfwNames) {
      const genre = filters.genres.find(g => g.name === name);
      expect(genre).toBeDefined();
      expect((genre as { nsfw?: boolean }).nsfw).toBe(true);
    }
  });
});

// ── Chapter Image Extraction ───────────────────────────────────────────

describe('T-C7-1: Extracts images from escaped format', () => {
  it('parses escaped JSON image array', () => {
    const html = 'prefix \\"images\\":[{\\"url\\":\\"https:\\/\\/cdn.com\\/page1.jpg\\",\\"width\\":800,\\"height\\":1200}] suffix';
    const result = provider.parseChapterImagesResponse(html);
    expect(result).toEqual([{ url: 'https://cdn.com/page1.jpg', width: 800, height: 1200 }]);
  });
});

describe('T-C7-2: Extracts images from unescaped format', () => {
  it('parses unescaped JSON image array', () => {
    const html = 'prefix "images":[{"url":"https://cdn.com/page1.jpg","width":800,"height":1200}] suffix';
    const result = provider.parseChapterImagesResponse(html);
    expect(result).toEqual([{ url: 'https://cdn.com/page1.jpg', width: 800, height: 1200 }]);
  });
});

describe('T-C7-3: Tries escaped first, falls back to unescaped', () => {
  it('escaped format extracts successfully', () => {
    const html = 'prefix \\"images\\":[{\\"url\\":\\"https:\\/\\/cdn.com\\/page1.jpg\\",\\"width\\":800,\\"height\\":1200}] suffix';
    const result = provider.parseChapterImagesResponse(html);
    expect(result).toHaveLength(1);
  });

  it('unescaped format extracts successfully (fallback)', () => {
    const html = 'prefix "images":[{"url":"https://cdn.com/page1.jpg","width":800,"height":1200}] suffix';
    const result = provider.parseChapterImagesResponse(html);
    expect(result).toHaveLength(1);
  });

  it('neither format throws', () => {
    const html = '<html><body>No images here</body></html>';
    expect(() => provider.parseChapterImagesResponse(html)).toThrow();
  });
});

describe('T-C7-4: Validates extracted JSON with JSON.parse', () => {
  it('throws on invalid JSON inside images pattern', () => {
    const html = '"images":[{not valid json}]';
    expect(() => provider.parseChapterImagesResponse(html)).toThrow();
  });
});

// ── Image Referer Header ───────────────────────────────────────────────

describe('T-C8-1: imageHeaders returns Referer', () => {
  it("returns { Referer: 'https://comix.to' }", () => {
    const headers = provider.imageHeaders!();
    expect(headers).toEqual({ Referer: 'https://comix.to' });
  });
});

// ── Manga ID ───────────────────────────────────────────────────────────

describe('T-C9-1: Uses hash_id as primary ID', () => {
  it("manga with hash_id='okdv' uses 'okdv' as id", () => {
    const data = {
      result: {
        items: [{
          hash_id: 'okdv',
          slug: 'one-piece',
          title: 'One Piece',
          poster: { medium: 'cover.jpg' },
        }],
      },
    };
    const result = provider.parseSearchResponse(data);
    expect(result.items[0].id).toBe('okdv');
  });
});

describe('T-C9-2: Falls back to slug if hash_id missing', () => {
  it("manga without hash_id uses slug as id", () => {
    const data = {
      result: {
        items: [{
          slug: 'one-piece',
          title: 'One Piece',
          poster: { medium: 'cover.jpg' },
        }],
      },
    };
    const result = provider.parseSearchResponse(data);
    expect(result.items[0].id).toBe('one-piece');
  });
});
