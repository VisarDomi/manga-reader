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
  SEARCH_DEBOUNCE_MS,
  VISIBLE_MANGA_DEBOUNCE_MS,
} from './constants.js';
import { READER_ROOT_MARGIN } from './logic.js';

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

describe('T-AC-1: All search inputs share 500ms debounce', () => {
  it('SEARCH_DEBOUNCE_MS === 500', () => {
    expect(SEARCH_DEBOUNCE_MS).toBe(500);
  });
});

describe('T-AP-2: Scroll tracking debounced at 1s', () => {
  it('VISIBLE_MANGA_DEBOUNCE_MS === 1_000', () => {
    expect(VISIBLE_MANGA_DEBOUNCE_MS).toBe(1_000);
  });
});

describe('T-BL-1: Reader Image Prefetch Margin', () => {
  it("READER_ROOT_MARGIN === '1500%'", () => {
    expect(READER_ROOT_MARGIN).toBe('1500%');
  });
});
