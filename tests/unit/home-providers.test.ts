// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ChapterLoadResultKind,
    Handler,
    HomeDestinationKind,
    type HomePage,
    type HomeSeries,
    type Provider,
    type RemoteSeriesHistory,
} from '../../src/provider';
import { createChapterProgress } from '../../src/core/compute/progress';
import { open as openHome } from '../../src/routes/home';

const historyState = vi.hoisted(() => ({ progress: [] as unknown[] }));
vi.mock('../../src/core/compute/transport', async () => {
    const { resolveHistory } = await import('../../src/core/compute/history');
    return {
        computeRequest: (_op: string, payload: { cards: unknown; remoteHistory: unknown }) => Promise.resolve(
            resolveHistory({
                cards: payload.cards as never,
                remoteHistory: payload.remoteHistory as never,
                progress: historyState.progress as never,
            }),
        ),
    };
});
function homeSeries(slug: string, chapters: string[] = []): HomeSeries {
    return {
        slug,
        title: slug,
        coverUrl: `https://example.test/${slug}.webp`,
        chapters: chapters.map(chapterId => ({
            chapterId,
            label: `Chapter ${chapterId}`,
            uploadedAt: null,
            locked: false,
            unlockAt: null,
        })),
    };
}

function testProvider(options: {
    fetchHome(cursor: string | null): Promise<HomePage>;
    fetchRemoteHistory?: () => Promise<RemoteSeriesHistory[]>;
    resolveHomeDestination?: Provider['resolveHomeDestination'];
}): Provider {
    return {
        key: 'test',
        matchRoute: () => ({ handler: Handler.Home }),
        fetchHome: options.fetchHome,
        fetchRemoteHistory: options.fetchRemoteHistory,
        loadChapter: async () => ({ kind: ChapterLoadResultKind.Stop }),
        resolveHomeDestination: options.resolveHomeDestination ?? (async request => (
            request.kind === HomeDestinationKind.Resume
                ? `/reader/${request.seriesSlug}/${request.chapterId}${
                    request.imageIndex === undefined ? '' : `#${request.imageIndex}`
                }`
                : `/series/${request.seriesSlug}`
        )),
        fetchChaptersNewestFirst: async () => [],
        readerUrl: (slug, chapterId, imageIndex) => `https://example.test/${slug}/${chapterId}${
            imageIndex === undefined ? '' : `#${imageIndex}`
        }`,
        seriesUrl: slug => `https://example.test/${slug}`,
    };
}

async function settleHistory(): Promise<void> {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(200);
}

beforeEach(() => {
    vi.useFakeTimers();
    historyState.progress = [];
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    document.body.replaceChildren();
});

describe('Home behavior', () => {
    it('eventually shows every entry', async () => {
        const pages = new Map<string | null, HomePage>([
            [null, { series: [homeSeries('series-1')], nextCursor: 'page-2' }],
            ['page-2', { series: [homeSeries('series-2')], nextCursor: 'page-3' }],
            ['page-3', { series: [homeSeries('series-3')], nextCursor: null }],
        ]);
        const opening = openHome(testProvider({
            fetchHome: async cursor => pages.get(cursor)!,
        }));

        await vi.advanceTimersByTimeAsync(2_400);
        await opening;

        expect([...document.querySelectorAll<HTMLImageElement>('.hs-home-card img')]
            .map(cover => cover.alt)).toEqual(['series-1', 'series-2', 'series-3']);
        expect(document.querySelector('.hs-home-catalog-status')?.textContent).toBe('Loaded 3 series');
    });

    it('uses a local resume position instead of a server resume position', async () => {
        historyState.progress = [createChapterProgress('test', 'series-a', '2', 1, 5, 100)];
        const provider = testProvider({
            fetchHome: async () => ({ series: [homeSeries('series-a', ['5', '2'])], nextCursor: null }),
            fetchRemoteHistory: async () => [{
                seriesId: 'series-a',
                readChapterIds: ['5', '2'],
                resumeChapterId: '5',
            }],
        });

        await openHome(provider);
        await settleHistory();

        expect(document.querySelector<HTMLAnchorElement>('.hs-home-cover')?.href)
            .toBe('https://example.test/series-a/2#1');
    });

    it('uses server resume only when no local resume position exists', async () => {
        const resolveHomeDestination = vi.fn(async () => window.location.href);
        const provider = testProvider({
            fetchHome: async () => ({ series: [homeSeries('series-a', ['3', '2'])], nextCursor: null }),
            fetchRemoteHistory: async () => [{
                seriesId: 'series-a',
                readChapterIds: ['2'],
                resumeChapterId: '2',
            }],
            resolveHomeDestination,
        });

        await openHome(provider);
        await settleHistory();
        document.querySelector<HTMLAnchorElement>('.hs-home-cover')
            ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await Promise.resolve();

        expect(resolveHomeDestination).toHaveBeenCalledWith({
            kind: HomeDestinationKind.Resume,
            seriesSlug: 'series-a',
            chapterId: '2',
        });
    });

    it('links unread, read, and partial chapters to start, end, and saved page behavior', async () => {
        historyState.progress = [createChapterProgress('test', 'series-a', '2', 1, 5, 100)];
        const resolveHomeDestination = vi.fn(async () => window.location.href);
        const provider = testProvider({
            fetchHome: async () => ({ series: [homeSeries('series-a', ['3', '2', '1'])], nextCursor: null }),
            fetchRemoteHistory: async () => [{
                seriesId: 'series-a',
                readChapterIds: ['2', '1'],
                resumeChapterId: '2',
            }],
            resolveHomeDestination,
        });

        await openHome(provider);
        await settleHistory();

        const chapter = (id: string) => document.querySelector<HTMLAnchorElement>(
            `.hs-home-chapter[data-chapter-id="${id}"]`,
        )!;
        expect(chapter('3').href).toBe('https://example.test/series-a/3');
        expect(chapter('3').classList.contains('hs-home-chapter-read')).toBe(false);
        expect(chapter('2').href).toBe('https://example.test/series-a/2#1');
        expect(chapter('2').classList.contains('hs-home-chapter-partial')).toBe(true);
        expect(chapter('1').classList.contains('hs-home-chapter-read')).toBe(true);

        chapter('1').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await Promise.resolve();
        expect(resolveHomeDestination).toHaveBeenCalledWith({
            kind: HomeDestinationKind.Resume,
            seriesSlug: 'series-a',
            chapterId: '1',
        });
    });

    it('asks the provider to start when a cover has no resume position', async () => {
        const resolveHomeDestination = vi.fn(async () => window.location.href);
        await openHome(testProvider({
            fetchHome: async () => ({ series: [homeSeries('series-a')], nextCursor: null }),
            resolveHomeDestination,
        }));
        await settleHistory();

        document.querySelector<HTMLAnchorElement>('.hs-home-cover')
            ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await Promise.resolve();

        expect(resolveHomeDestination).toHaveBeenCalledWith({
            kind: HomeDestinationKind.Start,
            seriesSlug: 'series-a',
        });
    });
});
