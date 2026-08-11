// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
    getProviderProgress,
    isChapterComplete,
    saveChapterProgress,
} from '../../src/storage/progress';

describe('local page progress', () => {
    beforeEach(() => localStorage.clear());

    it('stores one current page per provider, series, and chapter', () => {
        saveChapterProgress('asurascans', 'series-a', '7', 1, 4);
        saveChapterProgress('asurascans', 'series-a', '7', 3, 4);
        saveChapterProgress('asurascans', 'series-a', '8', 0, 5);
        saveChapterProgress('valirscans', 'series-a', '7', 0, 2);

        const progress = getProviderProgress('asurascans');
        expect(progress).toHaveLength(2);
        const chapterSeven = progress.find(item => item.chapterId === '7');
        const chapterEight = progress.find(item => item.chapterId === '8');
        expect(chapterSeven).toMatchObject({ imageIndex: 3, totalImages: 4 });
        expect(chapterSeven?.updatedAt).toBeGreaterThan(0);
        expect(chapterSeven && isChapterComplete(chapterSeven)).toBe(true);
        expect(chapterEight && isChapterComplete(chapterEight)).toBe(false);
    });
});
