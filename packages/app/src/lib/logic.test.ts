import { describe, it, expect } from 'vitest';
import {
  EDGE_ZONE_RATIO,
  DEADZONE_RATIO,
  SWIPE_THRESHOLD,
  VISIBLE_PAGE_RATIO,
  MAX_CHAPTER_DISTANCE,
  SENTINEL_ROOT_MARGIN,
  LOADING_TIMEOUT_MS,
  HISTORY_SYNC_MS,
} from './constants.js';
import {
  View,
  Filter,
  ErrorKind,
  cycleGenreFilter,
  toggleBinaryFilter,
  deduplicateByMangaId,
  filteredChapters,
  VALID_STACKS,
  isValidStack,
  popViewStack,
  isTransient,
  READER_ROOT_MARGIN,
  type AppError,
} from './logic.js';

// ── Constants ──────────────────────────────────────────────────────────

describe('T-AT-1: Swipe Edge Zone', () => {
  it('EDGE_ZONE_RATIO === 0.077', () => {
    expect(EDGE_ZONE_RATIO).toBe(0.077);
  });
});

describe('T-AT-2: Swipe Deadzone', () => {
  it('DEADZONE_RATIO === 0.013', () => {
    expect(DEADZONE_RATIO).toBe(0.013);
  });
});

describe('T-AT-3: Swipe Threshold', () => {
  it('SWIPE_THRESHOLD_RATIO === 0.15', () => {
    expect(SWIPE_THRESHOLD).toBe(0.15);
  });
});

describe('T-AJ-1: Visible Page Ratio', () => {
  it('VISIBLE_PAGE_RATIO === 1/3', () => {
    expect(VISIBLE_PAGE_RATIO).toBe(1 / 3);
  });
});

describe('T-AK-2: Cache Window Size', () => {
  it('CACHE_WINDOW === 2', () => {
    expect(MAX_CHAPTER_DISTANCE).toBe(2);
  });
});

describe('T-AE-1: Infinite Scroll Sentinel', () => {
  it("SENTINEL_ROOT_MARGIN === '500% 0px'", () => {
    expect(SENTINEL_ROOT_MARGIN).toBe('500% 0px');
  });
});

describe('T-AX-1: Watchdog Timeout', () => {
  it('WATCHDOG_TIMEOUT_MS === 15_000', () => {
    expect(LOADING_TIMEOUT_MS).toBe(15_000);
  });
});

describe('T-AI-1: Progress Debounce Time', () => {
  it('PROGRESS_DEBOUNCE_MS === 3_000', () => {
    expect(HISTORY_SYNC_MS).toBe(3_000);
  });
});

describe('T-BL-1: Reader Image Prefetch Margin', () => {
  it("READER_ROOT_MARGIN === '1500%'", () => {
    expect(READER_ROOT_MARGIN).toBe('1500%');
  });
});

// ── Logic Functions ────────────────────────────────────────────────────

describe('T-AB-1: Genre filter cycles through 3 states', () => {
  it("empty → include", () => {
    expect(cycleGenreFilter(Filter.EMPTY)).toBe(Filter.INCLUDE);
  });
  it("include → exclude", () => {
    expect(cycleGenreFilter(Filter.INCLUDE)).toBe(Filter.EXCLUDE);
  });
  it("exclude → empty", () => {
    expect(cycleGenreFilter(Filter.EXCLUDE)).toBe(Filter.EMPTY);
  });
});

describe('T-AB-2: Type and status filters are binary toggles', () => {
  it('false → true', () => {
    expect(toggleBinaryFilter(false)).toBe(true);
  });
  it('true → false', () => {
    expect(toggleBinaryFilter(true)).toBe(false);
  });
});

describe('T-AD-1: Pagination deduplicates by manga ID', () => {
  it('deduplicates overlapping manga and preserves order', () => {
    const existing = [
      { id: 'A', title: 'A', cover: '', latestChapter: null },
      { id: 'B', title: 'B', cover: '', latestChapter: null },
      { id: 'C', title: 'C', cover: '', latestChapter: null },
    ];
    const incoming = [
      { id: 'C', title: 'C2', cover: '', latestChapter: null },
      { id: 'D', title: 'D', cover: '', latestChapter: null },
      { id: 'E', title: 'E', cover: '', latestChapter: null },
    ];
    const result = deduplicateByMangaId(existing, incoming);
    expect(result.map(m => m.id)).toEqual(['A', 'B', 'C', 'D', 'E']);
  });
});

describe('T-AF-1: Provider-wide group blacklist hides chapters', () => {
  it('blacklisted group chapters are hidden', () => {
    const chapters = [
      { id: '1', number: 1, groupId: 'gA', groupName: 'A' },
      { id: '2', number: 2, groupId: 'gX', groupName: 'X' },
    ];
    const result = filteredChapters(chapters, new Set(['gX']), null);
    expect(result.map(ch => ch.id)).toEqual(['1']);
  });
});

describe('T-AF-2: Per-manga group selector overrides blacklist', () => {
  it('selected group overrides blacklist', () => {
    const chapters = [
      { id: '1', number: 1, groupId: 'gA', groupName: 'A' },
      { id: '2', number: 2, groupId: 'gX', groupName: 'X' },
    ];
    const result = filteredChapters(chapters, new Set(['gX']), new Set(['gX']));
    expect(result.map(ch => ch.id)).toEqual(['2']);
  });
});

describe('T-AF-4: Same chapter number — latest upload wins', () => {
  it('group B uploaded later wins', () => {
    const chapters = [
      { id: '1', number: 5, groupId: 'gA', groupName: 'A', uploadedAt: 1704067200 },
      { id: '2', number: 5, groupId: 'gB', groupName: 'B', uploadedAt: 1704153600 },
    ];
    const result = filteredChapters(chapters, new Set(), new Set(['gA', 'gB']));
    expect(result.map(ch => ch.id)).toEqual(['2']);
  });
});

describe('T-AF-5: Chapters sorted descending by number', () => {
  it('chapters ordered [3, 2, 1]', () => {
    const chapters = [
      { id: '1', number: 1, groupId: 'gA', groupName: 'A' },
      { id: '3', number: 3, groupId: 'gA', groupName: 'A' },
      { id: '2', number: 2, groupId: 'gA', groupName: 'A' },
    ];
    const result = filteredChapters(chapters, new Set(), null);
    expect(result.map(ch => ch.number)).toEqual([3, 2, 1]);
  });
});

describe('T-AO-1: Exactly 7 valid view stack configurations', () => {
  it('VALID_STACKS contains all 7 configurations', () => {
    expect(VALID_STACKS).toEqual([
      [View.LIST],
      [View.LIST, View.REPOS],
      [View.LIST, View.FAVORITES],
      [View.LIST, View.MANGA],
      [View.LIST, View.FAVORITES, View.MANGA],
      [View.LIST, View.MANGA, View.READER],
      [View.LIST, View.FAVORITES, View.MANGA, View.READER],
    ]);
  });

  it('isValidStack returns true for each valid stack', () => {
    for (const stack of VALID_STACKS) {
      expect(isValidStack(stack)).toBe(true);
    }
  });

  it('isValidStack returns false for invalid stacks', () => {
    expect(isValidStack([View.READER])).toBe(false);
    expect(isValidStack([View.LIST, View.READER])).toBe(false);
    expect(isValidStack([View.MANGA, View.LIST])).toBe(false);
  });
});

describe('T-AO-2: Back always pops one level', () => {
  it('[list, manga, reader] → [list, manga]', () => {
    expect(popViewStack([View.LIST, View.MANGA, View.READER])).toEqual([View.LIST, View.MANGA]);
  });
  it('[list, manga] → [list]', () => {
    expect(popViewStack([View.LIST, View.MANGA])).toEqual([View.LIST]);
  });
  it('[list] → [list] (cannot pop below root)', () => {
    expect(popViewStack([View.LIST])).toEqual([View.LIST]);
  });
});

describe('T-AO-3: Repos is a leaf', () => {
  it('[list, repos, manga] is invalid — repos allows no deeper pushes', () => {
    expect(isValidStack([View.LIST, View.REPOS, View.MANGA])).toBe(false);
  });
  it('[list, repos] is valid — repos is a valid leaf', () => {
    expect(isValidStack([View.LIST, View.REPOS])).toBe(true);
  });
});

describe('T-AZ-1: Errors are a tagged union of 5 kinds', () => {
  it('HTTP 404 → { kind: upstream, status: 404 }', () => {
    const err: AppError = { kind: ErrorKind.UPSTREAM, status: 404 };
    expect(err.kind).toBe(ErrorKind.UPSTREAM);
    expect(err.status).toBe(404);
  });
  it('timeout → { kind: timeout }', () => {
    const err: AppError = { kind: ErrorKind.TIMEOUT };
    expect(err.kind).toBe(ErrorKind.TIMEOUT);
  });
  it('TypeError → { kind: network }', () => {
    const err: AppError = { kind: ErrorKind.NETWORK };
    expect(err.kind).toBe(ErrorKind.NETWORK);
  });
  it('503 + Cloudflare → { kind: cloudflare }', () => {
    const err: AppError = { kind: ErrorKind.CLOUDFLARE };
    expect(err.kind).toBe(ErrorKind.CLOUDFLARE);
  });
  it('parse failure → { kind: parse }', () => {
    const err: AppError = { kind: ErrorKind.PARSE };
    expect(err.kind).toBe(ErrorKind.PARSE);
  });
});

describe('T-AY-1: Transient error detection', () => {
  const cases: [AppError, string][] = [
    [{ kind: ErrorKind.UPSTREAM, status: 408 }, 'upstream 408'],
    [{ kind: ErrorKind.UPSTREAM, status: 429 }, 'upstream 429'],
    [{ kind: ErrorKind.UPSTREAM, status: 500 }, 'upstream 500'],
    [{ kind: ErrorKind.UPSTREAM, status: 502 }, 'upstream 502'],
    [{ kind: ErrorKind.UPSTREAM, status: 503 }, 'upstream 503'],
    [{ kind: ErrorKind.UPSTREAM, status: 504 }, 'upstream 504'],
    [{ kind: ErrorKind.TIMEOUT }, 'timeout'],
    [{ kind: ErrorKind.NETWORK }, 'network'],
  ];
  for (const [error, label] of cases) {
    it(`returns true for ${label}`, () => {
      expect(isTransient(error)).toBe(true);
    });
  }
});

describe('T-AY-2: Permanent error detection', () => {
  const cases: [AppError, string][] = [
    [{ kind: ErrorKind.UPSTREAM, status: 400 }, 'upstream 400'],
    [{ kind: ErrorKind.UPSTREAM, status: 403 }, 'upstream 403'],
    [{ kind: ErrorKind.UPSTREAM, status: 404 }, 'upstream 404'],
    [{ kind: ErrorKind.PARSE }, 'parse'],
    [{ kind: ErrorKind.CLOUDFLARE }, 'cloudflare'],
  ];
  for (const [error, label] of cases) {
    it(`returns false for ${label}`, () => {
      expect(isTransient(error)).toBe(false);
    });
  }
});
