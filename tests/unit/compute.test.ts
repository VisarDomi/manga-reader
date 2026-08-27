import { describe, expect, it } from 'vitest';
import { CoverResumeKind, resolveHistory } from '../../src/core/compute/history';
import {
    buildProgressIndex,
    createChapterProgress,
    isChapterComplete,
    progressKey,
} from '../../src/core/compute/progress';

const card = (chapterIds: string[]) => ({
    seriesSlug: 'series-a',
    historyId: 'series-a',
    chapterIds,
});

describe('resolveHistory', () => {
    it('marks the exact chapters reported by remote history', () => {
        const [result] = resolveHistory({
            cards: [card(['4', '3', '2'])],
            remoteHistory: [{ seriesId: 'series-a', readChapterIds: ['3', '2'], resumeChapterId: '3' }],
            progress: [],
        });
        expect(result.chapters.map(chapter => [chapter.chapterId, chapter.read])).toEqual([
            ['4', false],
            ['3', true],
            ['2', true],
        ]);
        expect(result.cover).toEqual({
            kind: CoverResumeKind.Read,
            resumeChapterId: '3',
            locallyReadChapterIds: [],
        });
    });

    it('lets local partial progress override remote chapter history', () => {
        const progress = [createChapterProgress('test', 'series-a', '7', 1, 5, 100)];
        const [result] = resolveHistory({
            cards: [card(['7', '6'])],
            remoteHistory: [{ seriesId: 'series-a', readChapterIds: ['6'], resumeChapterId: '7' }],
            progress,
        });
        const seven = result.chapters.find(chapter => chapter.chapterId === '7');
        expect(seven).toMatchObject({ read: false, partial: true, localImageIndex: 1 });
        expect(result.cover).toEqual({
            kind: CoverResumeKind.LocalPartial,
            chapterId: '7',
            imageIndex: 1,
        });
    });

    it('local progress trumps server for chapters beyond the resume point', () => {
        const progress = [createChapterProgress('test', 'series-a', '4', 0, 5, 100)];
        const [result] = resolveHistory({
            cards: [card(['4', '3'])],
            remoteHistory: [{ seriesId: 'series-a', readChapterIds: ['3'], resumeChapterId: '3' }],
            progress,
        });
        const four = result.chapters.find(chapter => chapter.chapterId === '4');
        expect(four).toMatchObject({ read: false, partial: true, localImageIndex: 0 });
    });

    it('falls back to local completion state when no remote history exists', () => {
        const progress = [
            createChapterProgress('test', 'series-a', '3', 4, 5, 100),
            createChapterProgress('test', 'series-a', '2', 1, 5, 90),
        ];
        const [result] = resolveHistory({
            cards: [card(['3', '2'])],
            remoteHistory: [],
            progress,
        });
        expect(result.chapters.find(chapter => chapter.chapterId === '3')?.read).toBe(true);
        expect(result.chapters.find(chapter => chapter.chapterId === '2')).toMatchObject({
            read: false,
            partial: true,
            localImageIndex: 1,
        });
        expect(result.cover).toEqual({
            kind: CoverResumeKind.LocalPartial,
            chapterId: '2',
            imageIndex: 1,
        });
    });

    it('marks every complete chapter read with no remote history', () => {
        const progress = [
            createChapterProgress('test', 'series-a', '3', 4, 5, 100),
            createChapterProgress('test', 'series-a', '2', 4, 5, 90),
        ];
        const [result] = resolveHistory({
            cards: [card(['3', '2', '1'])],
            remoteHistory: [],
            progress,
        });
        expect(result.cover).toEqual({
            kind: CoverResumeKind.Read,
            locallyReadChapterIds: expect.arrayContaining(['3', '2']),
            latestLocalComplete: { chapterId: '3', imageIndex: 4 },
        });
        expect(result.chapters.find(chapter => chapter.chapterId === '1')?.read).toBe(false);
    });
});

describe('progress helpers', () => {
    it('rejects invalid save parameters', () => {
        expect(() => createChapterProgress('test', 'series-a', '7', -1, 5)).toThrow(/invalid page index/);
        expect(() => createChapterProgress('test', 'series-a', '7', 5, 5)).toThrow(/outside the chapter page range/);
    });

    it('indexes entries by chapter key and series slug', () => {
        const entries = [
            createChapterProgress('test', 'series-a', '7', 1, 5, 1),
            createChapterProgress('test', 'series-a', '8', 0, 5, 2),
            createChapterProgress('test', 'series-b', '1', 0, 3, 3),
        ];
        const index = buildProgressIndex(entries);
        expect(index.byChapter.get(progressKey('series-a', '8'))?.chapterId).toBe('8');
        expect(index.bySeries.get('series-b')).toHaveLength(1);
    });

    it('detects completion at the final page', () => {
        expect(isChapterComplete(createChapterProgress('t', 's', '1', 4, 5))).toBe(true);
        expect(isChapterComplete(createChapterProgress('t', 's', '1', 0, 5))).toBe(false);
    });
});
