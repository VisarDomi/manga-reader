import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ChapterLoadResultKind,
    Handler,
    type ChapterData,
    type Provider,
} from '../../src/provider';
import { createReaderTracker } from '../../src/core/tracking';

const calls: Array<{ op: string; payload: unknown }> = [];
vi.mock('../../src/core/compute/transport', () => ({
    computeRequest: vi.fn(async (op: string, payload: unknown) => {
        calls.push({ op, payload });
    }),
    onComputeNotification: vi.fn(),
}));

function chapter(chapterId: string): ChapterData {
    return {
        chapterId,
        seriesSlug: 'series',
        seriesTitle: 'Series',
        images: [{ url: 'page-1' }, { url: 'page-2' }],
    };
}

function provider(trackChapter?: Provider['trackChapter']): Provider {
    return {
        key: 'test',
        documentTitle: 'Test',
        matchRoute: () => ({ handler: Handler.Home }),
        fetchHome: async () => ({ series: [], nextCursor: null }),
        loadChapter: async () => ({ kind: ChapterLoadResultKind.Stop }),
        resolveHomeDestination: async () => '/series',
        trackChapter,
        fetchChaptersNewestFirst: async () => [],
        readerUrl: () => '/chapter',
        seriesUrl: () => '/series',
    };
}

beforeEach(() => calls.length = 0);

describe('reader tracking', () => {
    it('updates local page position while server tracking happens once per chapter', () => {
        const trackChapter = vi.fn(async () => {});
        const tracker = createReaderTracker(provider(trackChapter), {
            seriesSlug: 'series',
            onError: vi.fn(),
        });
        const chapterOne = chapter('1');
        const chapterTwo = chapter('2');

        tracker.track(chapterOne, '0');
        tracker.track(chapterOne, '1');
        tracker.track(chapterOne, '1');
        tracker.track(chapterOne, '0');
        tracker.track(chapterTwo, '0');

        const local = calls
            .filter(call => call.op === 'save-progress')
            .map(call => call.payload as { chapterId: string; imageIndex: number });
        expect(local.map(entry => [entry.chapterId, entry.imageIndex])).toEqual([
            ['1', 0],
            ['1', 1],
            ['1', 0],
            ['2', 0],
        ]);
        expect(trackChapter.mock.calls.map(([data]) => data.chapterId)).toEqual(['1', '2']);
    });

    it('still updates local position when the provider has no server tracking', () => {
        const tracker = createReaderTracker(provider(), {
            seriesSlug: 'series',
            onError: vi.fn(),
        });

        tracker.track(chapter('1'), '1');

        expect(calls.filter(call => call.op === 'save-progress')).toHaveLength(1);
    });
});
