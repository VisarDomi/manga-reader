import { describe, expect, it } from 'vitest';
import { CoverResumeKind, resolveHistory } from '../../src/core/compute/history';
import { createChapterProgress } from '../../src/core/compute/progress';
import {
    migrateProgress,
    ProgressSchemaVersion,
} from '../../src/core/compute/migrations';

const card = (chapterIds: string[]) => ({
    seriesSlug: 'series-a',
    historyId: 'series-a',
    chapterIds,
});

describe('local resume position', () => {
    it('has one storage identity per provider and series', () => {
        const chapterTwo = createChapterProgress('test', 'series-a', '2', 0, 5);
        const chapterFive = createChapterProgress('test', 'series-a', '5', 0, 5);
        expect(chapterTwo.id).toBe(chapterFive.id);
        expect(chapterTwo.id).not.toBe(createChapterProgress('test', 'series-b', '2', 0, 5).id);
        expect(chapterTwo.id).not.toBe(createChapterProgress('other', 'series-a', '2', 0, 5).id);
    });

    it('preserves the last visited position when migrating per-chapter history', () => {
        const oldChapterTwo = {
            ...createChapterProgress('test', 'series-a', '2', 1, 5, 100),
            id: 'test\u0000series-a\u00002',
        };
        const oldChapterFive = {
            ...createChapterProgress('test', 'series-a', '5', 3, 6, 200),
            id: 'test\u0000series-a\u00005',
        };

        const result = migrateProgress(
            [oldChapterTwo, oldChapterFive],
            ProgressSchemaVersion.PerChapter,
        );

        expect(result.entries).toEqual([
            createChapterProgress('test', 'series-a', '5', 3, 6, 200),
        ]);
        expect(result.schemaVersion).toBe(ProgressSchemaVersion.ResumePosition);
        expect(result.needsCommit).toBe(true);
    });

    it('uses the local position even when server resume names another chapter', () => {
        const [result] = resolveHistory({
            cards: [card(['5', '4', '3', '2', '1'])],
            remoteHistory: [{
                seriesId: 'series-a',
                readChapterIds: ['5', '4', '3', '2', '1'],
                resumeChapterId: '5',
            }],
            progress: [createChapterProgress('test', 'series-a', '2', 1, 5, 100)],
        });

        expect(result.cover).toEqual({
            kind: CoverResumeKind.LocalPartial,
            chapterId: '2',
            imageIndex: 1,
        });
    });

    it('uses server resume only when no local position exists', () => {
        const [result] = resolveHistory({
            cards: [card(['3', '2', '1'])],
            remoteHistory: [{
                seriesId: 'series-a',
                readChapterIds: ['2', '1'],
                resumeChapterId: '2',
            }],
            progress: [],
        });

        expect(result.cover).toEqual({
            kind: CoverResumeKind.Read,
            resumeChapterId: '2',
            locallyReadChapterIds: [],
        });
    });

    it('derives read, partial, and unread chapter states from the local position', () => {
        const [result] = resolveHistory({
            cards: [card(['3', '2', '1'])],
            remoteHistory: [],
            progress: [createChapterProgress('test', 'series-a', '2', 1, 5, 100)],
        });

        expect(result.chapters).toEqual([
            { chapterId: '3', read: false, partial: false },
            { chapterId: '2', read: false, partial: true, localImageIndex: 1 },
            { chapterId: '1', read: true, partial: false },
        ]);
    });
});
