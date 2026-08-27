// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    ChapterLoadIntent,
    ChapterLoadResultKind,
    Handler,
    type ChapterData,
    type Provider,
} from '../../src/provider';
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
        loadChapter: async () => ({ kind: ChapterLoadResultKind.Chapter, data }),
        resolveHomeDestination: async () => '/series/series',
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
    vi.useRealTimers();
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

describe('reader loading states', () => {
    it('keeps a failed chapter list as an explicit terminal status', async () => {
        const data = chapter([{ url: 'https://example.test/page.webp' }]);
        const provider: Provider = {
            ...providerFor(data),
            fetchChaptersNewestFirst: async () => { throw new Error('list failed'); },
        };

        await open(provider, { handler: Handler.Reader, slug: 'series', chapterId: '1' });

        await vi.waitFor(() => expect(document.querySelector('.hs-error')?.textContent)
            .toBe('Failed to load chapter list'));
        expect(document.querySelector('.hs-loading')).toBeNull();
    });

    it('moves an appended chapter failure out of loading and does not retry implicitly', async () => {
        vi.useFakeTimers();
        const data = chapter([{ url: 'https://example.test/page.webp' }]);
        const loadChapter = vi.fn(async (request: { intent: ChapterLoadIntent }) => {
            if (request.intent === ChapterLoadIntent.Open) {
                return { kind: ChapterLoadResultKind.Chapter, data };
            }
            throw new Error('append failed');
        }) as Provider['loadChapter'];
        const provider: Provider = {
            ...providerFor(data),
            loadChapter,
            fetchChaptersNewestFirst: async () => [{ chapterId: '2' }, { chapterId: '1' }],
        };

        await open(provider, { handler: Handler.Reader, slug: 'series', chapterId: '1' });
        await Promise.resolve();
        const image = document.querySelector<HTMLImageElement>('.hs-reader-img')!;
        Object.defineProperties(image, {
            complete: { configurable: true, value: true },
            naturalWidth: { configurable: true, value: 800 },
            naturalHeight: { configurable: true, value: 1200 },
        });

        await vi.advanceTimersByTimeAsync(100);
        expect(document.querySelector('.hs-error')?.textContent).toBe('Failed to load chapter');
        expect(document.querySelector('.hs-loading')).toBeNull();

        window.dispatchEvent(new Event('scrollend'));
        await vi.advanceTimersByTimeAsync(100);
        expect(loadChapter).toHaveBeenCalledTimes(2);
    });
});
