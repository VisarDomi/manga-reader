import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ChapterLoadResultKind,
    Handler,
    type ChapterData,
    type Provider,
} from '../../src/provider';
import { createReaderTracker } from '../../src/core/tracking';

// jsdom has no Worker: observe the ops the tracker dispatches.
const calls: Array<{ op: string; payload: unknown }> = [];
let saveProgressFails = false;
vi.mock('../../src/core/compute/transport', () => ({
    computeRequest: vi.fn(async (op: string, payload: unknown) => {
        calls.push({ op, payload });
        if (op === 'save-progress' && saveProgressFails) throw new Error('storage failed');
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

const payloadFor = (op: string) => calls
    .filter(call => call.op === op)
    .map(call => call.payload);

beforeEach(() => {
    calls.length = 0;
    saveProgressFails = false;
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('reader tracking', () => {
    it('saves each page once and tracks each chapter once (asura)', () => {
        const trackChapter = vi.fn(async () => {});
        const provider: Provider = {
            key: 'asurascans',
            documentTitle: 'Asura',
            matchRoute: () => ({ handler: Handler.Home }),
            fetchHome: async () => ({ series: [], nextCursor: null }),
            loadChapter: async () => ({ kind: ChapterLoadResultKind.Stop }),
            resolveHomeDestination: async () => '/series',
            trackChapter,
            fetchChaptersNewestFirst: async () => [],
            readerUrl: () => '/chapter',
            seriesUrl: () => '/series',
        };
        const tracker = createReaderTracker(provider, { seriesSlug: 'series', onError: vi.fn() });
        const chapterOne = chapter('1');
        const chapterTwo = chapter('2');

        tracker.track(chapterOne, '0');
        tracker.track(chapterOne, '0');
        tracker.track(chapterOne, '1');
        tracker.track(chapterOne, '0');
        tracker.track(chapterTwo, '0');

        const saves = payloadFor('save-progress') as Array<{ chapterId: string; imageIndex: number }>;
        expect(saves.map(save => [save.chapterId, save.imageIndex])).toEqual([
            ['1', 0],
            ['1', 1],
            ['2', 0],
        ]);
        expect(trackChapter.mock.calls.map(([data]) => data.chapterId)).toEqual(['1', '2']);
    });

    it('moves a failed page save into a terminal error state', async () => {
        saveProgressFails = true;
        const onError = vi.fn();
        const provider: Provider = {
            key: 'test',
            documentTitle: 'Test',
            matchRoute: () => ({ handler: Handler.Home }),
            fetchHome: async () => ({ series: [], nextCursor: null }),
            loadChapter: async () => ({ kind: ChapterLoadResultKind.Stop }),
            resolveHomeDestination: async () => '/series',
            fetchChaptersNewestFirst: async () => [],
            readerUrl: () => '/chapter',
            seriesUrl: () => '/series',
        };
        const tracker = createReaderTracker(provider, { seriesSlug: 'series', onError });

        tracker.track(chapter('1'), '0');
        await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
        tracker.track(chapter('1'), '0');

        expect(payloadFor('save-progress')).toHaveLength(1);
    });
});
