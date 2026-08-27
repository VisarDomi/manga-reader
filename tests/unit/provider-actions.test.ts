import { describe, expect, it, vi } from 'vitest';
import { chapterLoader, homeDestinationResolver } from '../../src/provider/actions';
import {
    ChapterLoadIntent,
    ChapterLoadResultKind,
    HomeDestinationKind,
    type ChapterData,
} from '../../src/provider';

function chapter(chapterId = '2'): ChapterData {
    return {
        chapterId,
        seriesSlug: 'series',
        seriesTitle: 'Series',
        images: [
            { url: 'https://example.test/1.webp' },
            { url: 'https://example.test/2.webp' },
            { url: 'https://example.test/3.webp' },
        ],
    };
}

describe('provider actions', () => {
    it('lets the provider distinguish an unavailable initial chapter from append exhaustion', async () => {
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
        await expect(load({
            slug: 'series',
            chapterId: '2',
            intent: ChapterLoadIntent.Append,
        })).resolves.toEqual({
            kind: ChapterLoadResultKind.Stop,
        });
    });

    it('passes successful chapter data through without route-level interpretation', async () => {
        const data = chapter();
        const load = chapterLoader(async () => data, () => '/series');

        await expect(load({
            slug: 'series',
            chapterId: '2',
            intent: ChapterLoadIntent.Open,
        })).resolves.toEqual({
            kind: ChapterLoadResultKind.Chapter,
            data,
        });
    });

    it('owns start and server-resume destinations inside the provider', async () => {
        const fetchChapter = vi.fn(async () => chapter());
        const resolve = homeDestinationResolver({
            fetchChapter,
            fetchChaptersNewestFirst: async () => [
                { chapterId: '3' },
                { chapterId: '2' },
                { chapterId: '1' },
            ],
            readerUrl: (slug, chapterId, imageIndex) =>
                `https://example.test/read/${slug}/${chapterId}${imageIndex === undefined ? '' : `#${imageIndex}`}`,
            seriesUrl: slug => `https://example.test/series/${slug}`,
        });

        await expect(resolve({ kind: HomeDestinationKind.Start, seriesSlug: 'series' }))
            .resolves.toBe('https://example.test/read/series/1');
        await expect(resolve({
            kind: HomeDestinationKind.Resume,
            seriesSlug: 'series',
            chapterId: '2',
        }))
            .resolves.toBe('https://example.test/read/series/2#2');
        expect(fetchChapter).toHaveBeenCalledOnce();
    });

    it('uses the provider series page when no chapter can supply a destination', async () => {
        const resolve = homeDestinationResolver({
            fetchChapter: async () => null,
            fetchChaptersNewestFirst: async () => [],
            readerUrl: () => '/reader',
            seriesUrl: slug => `/series/${slug}`,
        });

        await expect(resolve({ kind: HomeDestinationKind.Start, seriesSlug: 'empty' }))
            .resolves.toBe('/series/empty');
        await expect(resolve({
            kind: HomeDestinationKind.Resume,
            seriesSlug: 'empty',
            chapterId: '2',
        }))
            .resolves.toBe('/series/empty');
    });
});
