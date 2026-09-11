// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ChapterLoadIntent,
    ChapterLoadResultKind,
    Handler,
    type ChapterData,
    type Provider,
} from '../../src/provider';
import { open } from '../../src/routes/reader';

const tracking = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../../src/core/tracking', () => ({
    createReaderTracker: () => tracking,
}));

function chapter(chapterId: string, imageCount = 1): ChapterData {
    return {
        chapterId,
        seriesSlug: 'series',
        seriesTitle: 'Series',
        images: Array.from({ length: imageCount }, (_, index) => ({
            url: `https://example.test/${chapterId}-${index}.webp`,
        })),
    };
}

function providerFor(data: ChapterData): Provider {
    return {
        key: 'test',
        matchRoute: () => ({ handler: Handler.Home }),
        fetchHome: async () => ({ series: [], nextCursor: null }),
        loadChapter: async () => ({ kind: ChapterLoadResultKind.Chapter, data }),
        resolveHomeDestination: async () => '/series/series',
        fetchChaptersNewestFirst: async () => [{ chapterId: data.chapterId }],
        readerUrl: (_slug, chapterId, imageIndex) => `/${chapterId}${imageIndex ? `#${imageIndex}` : ''}`,
        seriesUrl: slug => `/series/${slug}`,
    };
}

function loadImage(image: HTMLImageElement): void {
    Object.defineProperties(image, {
        complete: { configurable: true, value: true },
        naturalWidth: { configurable: true, value: 800 },
        naturalHeight: { configurable: true, value: 1200 },
    });
    image.dispatchEvent(new Event('load'));
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    window.dispatchEvent(new Event('pagehide'));
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    tracking.track.mockClear();
    document.body.replaceChildren();
});

describe('Reader behavior', () => {
    it('self-registers rendered images for retry after a failed load', async () => {
        const data = chapter('1');
        data.images[0].url = `${location.origin}/image.webp`;

        await open(
            providerFor(data),
            { handler: Handler.Reader, slug: 'series', chapterId: '1' },
        );

        const image = document.querySelector<HTMLImageElement>('.hs-reader-img')!;
        Object.defineProperties(image, {
            complete: { configurable: true, value: true },
            naturalWidth: { configurable: true, value: 0 },
        });
        await vi.advanceTimersByTimeAsync(1_000);

        expect(new URL(image.src).searchParams.get('retry')).toBeTruthy();
    });

    it('uses 1000px without provider height, then replaces it with the loaded ratio', async () => {
        await open(
            providerFor(chapter('1')),
            { handler: Handler.Reader, slug: 'series', chapterId: '1' },
        );

        const image = document.querySelector<HTMLImageElement>('.hs-reader-img')!;
        expect(image.style.height).toBe('1000px');
        loadImage(image);
        expect(image.style.height).toBe('');
        expect(image.style.aspectRatio).toBe('800/1200');
    });

    it('updates the URL and tracking, then appends the immediate newer chapter once', async () => {
        const first = chapter('1');
        const second = chapter('2');
        const loadChapter = vi.fn(async (request: { intent: ChapterLoadIntent }) => (
            request.intent === ChapterLoadIntent.Open
                ? { kind: ChapterLoadResultKind.Chapter, data: first }
                : { kind: ChapterLoadResultKind.Chapter, data: second }
        )) as Provider['loadChapter'];
        const provider: Provider = {
            ...providerFor(first),
            loadChapter,
            fetchChaptersNewestFirst: async () => [{ chapterId: '2' }, { chapterId: '1' }],
        };
        const replaceState = vi.spyOn(window.history, 'replaceState');

        await open(provider, { handler: Handler.Reader, slug: 'series', chapterId: '1' });
        await Promise.resolve();
        loadImage(document.querySelector<HTMLImageElement>('.hs-reader-img')!);
        await vi.advanceTimersByTimeAsync(99);
        expect(replaceState).not.toHaveBeenCalled();
        expect(tracking.track).not.toHaveBeenCalled();
        expect(loadChapter).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(replaceState).toHaveBeenCalledWith(null, '', '/1#0');
        expect(tracking.track).toHaveBeenCalledWith(first, '0');
        await Promise.resolve();
        expect([...document.querySelectorAll<HTMLElement>('.hs-chapter')]
            .map(element => element.dataset.chapter)).toEqual(['1', '2']);

        window.dispatchEvent(new Event('scrollend'));
        await vi.advanceTimersByTimeAsync(100);
        expect(loadChapter).toHaveBeenCalledTimes(2);
    });

    it('restores the corresponding image from a reader URL', async () => {
        const data = chapter('1', 2);
        const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});

        await open(
            providerFor(data),
            { handler: Handler.Reader, slug: 'series', chapterId: '1', imageIndex: '1' },
        );

        const images = [...document.querySelectorAll<HTMLImageElement>('.hs-reader-img')];
        loadImage(images[1]);
        loadImage(images[0]);
        await vi.waitFor(() => expect(scrollTo).toHaveBeenCalled());
        expect(scrollTo).toHaveBeenLastCalledWith(0, images[1].offsetTop);
    });

    it('applies cached intrinsic sizes before measuring the next lazy image', async () => {
        const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
        await open(providerFor(chapter('1', 3)),
            { handler: Handler.Reader, slug: 'series', chapterId: '1', imageIndex: '2' });
        const images = [...document.querySelectorAll<HTMLImageElement>('.hs-reader-img')];
        // Reproduce Safari: complete/naturalWidth become available before load.
        Object.defineProperties(images[1], {
            complete: { configurable: true, value: true },
            naturalWidth: { configurable: true, value: 900 },
            naturalHeight: { configurable: true, value: 16000 },
        });
        Object.defineProperty(images[2], 'offsetTop', {
            get: () => images[1].style.height === '1000px' ? 1676 : 8285,
        });
        loadImage(images[0]);
        await vi.advanceTimersByTimeAsync(0);
        expect(scrollTo).toHaveBeenLastCalledWith(0, 8285);
        expect(scrollTo).not.toHaveBeenCalledWith(0, 1676);
    });

    it('never pulls the viewport back after input interrupts a pending image load', async () => {
        const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
        await open(providerFor(chapter('1', 3)),
            { handler: Handler.Reader, slug: 'series', chapterId: '1', imageIndex: '2' });
        const images = [...document.querySelectorAll<HTMLImageElement>('.hs-reader-img')];
        loadImage(images[0]);
        await vi.advanceTimersByTimeAsync(0);
        expect(scrollTo).toHaveBeenCalled();
        window.dispatchEvent(new Event('touchstart'));
        scrollTo.mockClear();
        loadImage(images[1]);
        loadImage(images[2]);
        await vi.advanceTimersByTimeAsync(0);
        expect(scrollTo).not.toHaveBeenCalled();
        window.dispatchEvent(new TouchEvent('touchend', { touches: [] }));
        window.dispatchEvent(new Event('scrollend'));
        await vi.advanceTimersByTimeAsync(100);
        expect(tracking.track).toHaveBeenCalled();
    });

    it('honors input received while the initial chapter request is still pending', async () => {
        const data = chapter('1', 2);
        let finish!: () => void;
        const provider = providerFor(data);
        provider.loadChapter = (() => new Promise(resolve => {
            finish = () => resolve({ kind: ChapterLoadResultKind.Chapter, data });
        })) as Provider['loadChapter'];
        const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
        const pending = open(provider,
            { handler: Handler.Reader, slug: 'series', chapterId: '1', imageIndex: '1' });
        window.dispatchEvent(new Event('pointerdown'));
        finish();
        await pending;
        document.querySelectorAll<HTMLImageElement>('.hs-reader-img').forEach(loadImage);
        await vi.advanceTimersByTimeAsync(0);
        expect(scrollTo).not.toHaveBeenCalled();
    });

    it('restores a fully cached chapter in one jump', async () => {
        vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
        vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(900);
        vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(16000);
        const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
        await open(providerFor(chapter('1', 32)),
            { handler: Handler.Reader, slug: 'series', chapterId: '1', imageIndex: '31' });
        await vi.advanceTimersByTimeAsync(0);
        expect(scrollTo).toHaveBeenCalledTimes(1);
        expect(document.getElementById('#30')!.style.height).toBe('');
    });
});
