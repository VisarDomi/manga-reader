import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChapterData, ChapterMeta } from '../../src/provider';
import { createReaderTracker } from '../../src/core/tracking';

// jsdom has no Worker: observe the ops the tracker dispatches.
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

const payloadFor = (op: string) => calls
    .filter(call => call.op === op)
    .map(call => call.payload);

beforeEach(() => {
    calls.length = 0;
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('reader tracking', () => {
    it('saves each page once and tracks each chapter once (asura)', () => {
        const tracker = createReaderTracker({ providerKey: 'asurascans', seriesSlug: 'series' });
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

        const saves = payloadFor('save-progress') as Array<{ chapterId: string; imageIndex: number }>;
        expect(saves.map(save => [save.chapterId, save.imageIndex])).toEqual([
            ['1', 0],
            ['1', 1],
            ['2', 0],
        ]);
        const chapterTracks = payloadFor('track-chapter') as Array<{ data: ChapterData }>;
        expect(chapterTracks.map(track => track.data.chapterId)).toEqual(['1', '2']);
    });

    it('waits for chapter metadata before deduplicating provider page tracking (valir)', async () => {
        const tracker = createReaderTracker({ providerKey: 'valirscans', seriesSlug: 'series' });
        const data = chapter('1');
        const chapters = [{ chapterId: '2' }, { chapterId: '1' }];

        tracker.track(data, '0', []);
        tracker.track(data, '0', chapters);
        tracker.track(data, '0', chapters);

        await Promise.resolve();
        expect(payloadFor('track-page')).toHaveLength(1);
    });
});
