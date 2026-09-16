import { describe, expect, it } from 'vitest';
import { CoverResumeKind, resolveHistory } from '../../src/core/compute/history';
import { createChapterProgress } from '../../src/core/compute/progress';

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

    it('resumes the saved local chapter even with newer chapters', () => {
        const [result] = resolveHistory({
            cards: [card(['5', '4', '3', '2', '1'])],
            progress: [createChapterProgress('test', 'series-a', '2', 1, 5, 100)],
        });

        expect(result.cover).toEqual({
            kind: CoverResumeKind.LocalPartial,
            chapterId: '2',
            imageIndex: 1,
        });
    });

    it('does not infer reading history when no local position exists', () => {
        const [result] = resolveHistory({
            cards: [card(['3', '2', '1'])],
            progress: [],
        });

        expect(result.cover).toEqual({
            kind: CoverResumeKind.None,
        });
    });

    it('derives read, partial, and unread chapter states from the local position', () => {
        const [result] = resolveHistory({
            cards: [card(['3', '2', '1'])],
            progress: [createChapterProgress('test', 'series-a', '2', 1, 5, 100)],
        });

        expect(result.chapters).toEqual([
            { chapterId: '3', read: false, partial: false },
            { chapterId: '2', read: false, partial: true, localImageIndex: 1 },
            { chapterId: '1', read: true, partial: false },
        ]);
    });
});
