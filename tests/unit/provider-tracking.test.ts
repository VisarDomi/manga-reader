import { describe, expect, it } from 'vitest';
import type { ChapterData, ChapterMeta } from '../../src/provider';
import { buildValirReadingPosition } from '../../src/provider/valir-remote';

const data: ChapterData = {
    chapterId: '11',
    seriesSlug: 'series',
    chapterApiId: 'chapter-api-11',
    seriesApiId: 'series-api',
    seriesTitle: 'Series',
    images: [{ url: 'page-1' }, { url: 'page-2' }, { url: 'page-3' }, { url: 'page-4' }],
};

describe('Valir reading position builder', () => {
    it('sends page progress and marks older chapters complete', () => {
        const chapters: ChapterMeta[] = [
            { chapterId: '12', chapterApiId: 'chapter-api-12' },
            { chapterId: '11', chapterApiId: 'chapter-api-11' },
            { chapterId: '10', chapterApiId: 'chapter-api-10' },
            { chapterId: '9' },
        ];

        expect(buildValirReadingPosition(data, '1', chapters)).toEqual({
            seriesId: 'series-api',
            chapters: [
                { chapterId: 'chapter-api-11', progress: 50 },
                { chapterId: 'chapter-api-10', progress: 100 },
            ],
        });
    });

    it('returns null without api ids', () => {
        expect(buildValirReadingPosition({ ...data, seriesApiId: undefined }, '1', [])).toBeNull();
    });
});
