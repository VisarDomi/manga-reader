// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Handler, type ChapterData, type Provider } from '../../src/provider';
import { open } from '../../src/routes/reader';

vi.mock('../../src/core/image-retry', () => ({ registerImage: vi.fn() }));
vi.mock('../../src/core/tracking', () => ({
    createReaderTracker: () => ({ track: vi.fn() }),
}));

function providerFor(data: ChapterData): Provider {
    return {
        key: 'test',
        documentTitle: 'Test',
        matchRoute: () => ({ handler: Handler.Home }),
        fetchHome: async () => ({ series: [], nextCursor: null }),
        fetchChapter: async () => data,
        fetchChaptersNewestFirst: async () => [{ chapterId: data.chapterId }],
        readerUrl: (_slug, chapterId, imageIndex) => `/${chapterId}${imageIndex ? `#${imageIndex}` : ''}`,
        seriesUrl: slug => `/series/${slug}`,
    };
}

function chapter(images: ChapterData['images']): ChapterData {
    return {
        chapterId: '1',
        seriesSlug: 'series',
        seriesTitle: 'Series',
        images,
    };
}

afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
});

describe('reader image sizing', () => {
    it('reserves 1000px when provider height is missing, then uses the loaded image ratio', async () => {
        await open(
            providerFor(chapter([{ url: 'https://example.test/page.webp' }])),
            { handler: Handler.Reader, slug: 'series', chapterId: '1' },
        );

        const image = document.querySelector<HTMLImageElement>('.hs-reader-img')!;
        expect(image.style.height).toBe('1000px');

        Object.defineProperties(image, {
            naturalWidth: { configurable: true, value: 800 },
            naturalHeight: { configurable: true, value: 1200 },
        });
        image.dispatchEvent(new Event('load'));

        expect(image.style.height).toBe('');
        expect(image.style.aspectRatio).toBe('800/1200');
    });

    it('keeps provider dimensions as the initial aspect ratio', async () => {
        await open(
            providerFor(chapter([{ url: 'https://example.test/page.webp', width: 800, height: 1200 }])),
            { handler: Handler.Reader, slug: 'series', chapterId: '1' },
        );

        const image = document.querySelector<HTMLImageElement>('.hs-reader-img')!;
        expect(image.style.height).toBe('');
        expect(image.style.aspectRatio).toBe('800/1200');
    });
});
