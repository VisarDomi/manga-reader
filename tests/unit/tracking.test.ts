import { describe, expect, it, vi } from 'vitest';
import type { ChapterData, ChapterMeta } from '../../src/provider';
import { createReaderTracker } from '../../src/routes/tracking';

function chapter(chapterId: string): ChapterData {
    return {
        chapterId,
        seriesTitle: 'Series',
        images: [{ url: 'page-1' }, { url: 'page-2' }],
    };
}

describe('reader tracking', () => {
    it('tracks each page once and each chapter once', () => {
        const trackPage = vi.fn(async () => {});
        const trackChapter = vi.fn(async () => {});
        const tracker = createReaderTracker({ trackPage, trackChapter });
        const chapters: ChapterMeta[] = [
            { chapterId: '2' },
            { chapterId: '1' },
        ];
        const chapterOne = chapter('1');
        const chapterTwo = chapter('2');

        tracker.track(chapterOne, '0', chapters);
        tracker.track(chapterOne, '0', chapters);
        tracker.track(chapterOne, '1', chapters);
        tracker.track(chapterOne, '0', chapters);
        tracker.track(chapterTwo, '0', chapters);

        expect(trackPage.mock.calls.map(([data, imageIndex]) => [data.chapterId, imageIndex])).toEqual([
            ['1', '0'],
            ['1', '1'],
            ['2', '0'],
        ]);
        expect(trackChapter.mock.calls.map(([data]) => data.chapterId)).toEqual(['1', '2']);
    });

    it('waits for chapter metadata before deduplicating provider page tracking', () => {
        const trackPage = vi.fn(async () => {});
        const tracker = createReaderTracker({ trackPage });
        const data = chapter('1');
        const chapters = [{ chapterId: '2' }, { chapterId: '1' }];

        tracker.track(data, '0', []);
        tracker.track(data, '0', chapters);
        tracker.track(data, '0', chapters);

        expect(trackPage).toHaveBeenCalledOnce();
        expect(trackPage).toHaveBeenCalledWith(data, '0', chapters);
    });
});
