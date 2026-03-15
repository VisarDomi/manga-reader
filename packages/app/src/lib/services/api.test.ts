import { describe, it, expect } from 'vitest';
import type { ChapterMeta } from '../types.js';
import { mergeChapterPages } from '../logic.js';

describe('T-AG-2: Deduplication on each batch', () => {
  it('duplicate chapter IDs across pages are deduplicated', () => {
    const pages: (ChapterMeta[] | null)[] = [
      [
        { id: 'ch-1', number: 1, groupName: 'A' },
        { id: 'ch-2', number: 2, groupName: 'A' },
      ],
      [
        { id: 'ch-2', number: 2, groupName: 'A' },
        { id: 'ch-3', number: 3, groupName: 'A' },
      ],
      null,
    ];

    const result = mergeChapterPages(pages);

    expect(result).toHaveLength(3);
    expect(result.map(ch => ch.id)).toEqual(['ch-1', 'ch-2', 'ch-3']);
  });
});

describe('T-AG-3: Partial data shown on partial failure', () => {
  it('returns chapters from succeeded pages when others failed', () => {
    const pages: (ChapterMeta[] | null)[] = [
      [
        { id: 'ch-5', number: 5, groupName: 'A' },
        { id: 'ch-4', number: 4, groupName: 'A' },
      ],
      null,
      null,
      null,
      null,
    ];

    const result = mergeChapterPages(pages);

    expect(result.length).toBeGreaterThan(0);
    expect(result.map(ch => ch.id)).toEqual(['ch-5', 'ch-4']);
  });

  it('returns empty array when all pages failed', () => {
    const pages: (ChapterMeta[] | null)[] = [null, null, null, null, null];

    const result = mergeChapterPages(pages);

    expect(result).toEqual([]);
  });
});
