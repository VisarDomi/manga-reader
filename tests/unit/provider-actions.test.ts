import { describe, expect, it } from 'vitest';
import { chapterLoader, homeDestinationResolver } from '../../src/provider/actions';
import {
    ChapterLoadIntent,
    ChapterLoadResultKind,
    HomeDestinationKind,
} from '../../src/provider';

describe('unavailable initial and resume destinations', () => {
    it('navigates an unavailable initial chapter to the provider series page', async () => {
        const load = chapterLoader(
            async () => null,
            slug => `https://example.test/series/${slug}`,
        );

        await expect(load({
            slug: 'series',
            chapterId: '2',
            intent: ChapterLoadIntent.Open,
        })).resolves.toEqual({
            kind: ChapterLoadResultKind.Navigate,
            url: 'https://example.test/series/series',
        });
    });

    it('navigates an unavailable resume to the provider series page', async () => {
        const resolve = homeDestinationResolver({
            fetchChapter: async () => null,
            fetchChaptersNewestFirst: async () => [],
            readerUrl: () => '/reader',
            seriesUrl: slug => `/series/${slug}`,
        });

        await expect(resolve({
            kind: HomeDestinationKind.Resume,
            seriesSlug: 'series',
            chapterId: '2',
        })).resolves.toBe('/series/series');
    });
});
