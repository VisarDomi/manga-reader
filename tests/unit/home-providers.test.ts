// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Handler, type HomePage, type Provider } from '../../src/provider';
import { createAngularProvider } from '../../src/provider/angular';
import { asura } from '../../src/provider/asura';
import { ezmanga } from '../../src/provider/ezmanga';
import { lua } from '../../src/provider/lua';
import { qiscans } from '../../src/provider/qiscans';
import { scythe } from '../../src/provider/scythe';
import { valir } from '../../src/provider/valir';
import { violet } from '../../src/provider/violet';
import { yaksha } from '../../src/provider/yaksha';
import { open as openHome } from '../../src/routes/home';

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
    document.body.replaceChildren();
});

describe('provider home routes', () => {
    it('takes over only the exact root path for every provider', () => {
        for (const provider of [asura, valir, scythe, lua, violet, ezmanga, qiscans, yaksha]) {
            expect(provider.documentTitle.trim()).not.toBe('');
            expect(provider.matchRoute('/', '')).toEqual({ handler: Handler.Home });
            expect(provider.matchRoute('/browse', '')).not.toEqual({ handler: Handler.Home });
            expect(provider.matchRoute('/series', '')).not.toEqual({ handler: Handler.Home });
            expect(provider.matchRoute('/manga/', '')).not.toEqual({ handler: Handler.Home });
        }
    });
});

describe('Angular catalog completion', () => {
    it('traverses every rich latest page before the complete catalog', async () => {
        const provider = createAngularProvider('qimanga');
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('/home/latest')) {
                const page = new URL(url).searchParams.get('page');
                return new Response(JSON.stringify({
                    data: [{
                        slug: `has-chapters-${page}`,
                        title: `Has Chapters ${page}`,
                        cover: 'https://example.test/a.webp',
                        chapters: [],
                    }],
                    totalItems: 2,
                    totalPages: 2,
                    next: page === '1' ? 2 : null,
                }));
            }
            return new Response(JSON.stringify({
                data: [{
                    slug: 'catalog-only',
                    title: 'Catalog Only',
                    cover: 'https://example.test/b.webp',
                }],
                totalItems: 2,
                totalPages: 1,
                next: null,
            }));
        });
        vi.stubGlobal('fetch', fetchMock);

        const latest = await provider.fetchHome(null);
        const moreLatest = await provider.fetchHome(latest.nextCursor);
        const catalog = await provider.fetchHome(moreLatest.nextCursor);

        expect(latest.nextCursor).toBe('latest:2');
        expect(moreLatest.nextCursor).toBe('catalog:1');
        expect(catalog).toMatchObject({
            total: 2,
            nextCursor: null,
            series: [{ slug: 'catalog-only', chapters: [] }],
        });
        expect(String(fetchMock.mock.calls[0][0])).toContain('perPage=50');
        expect(String(fetchMock.mock.calls[2][0])).toContain('/series?perPage=100&page=1');
    });

    it('uses totalPages when a chapter response omits next', async () => {
        const provider = createAngularProvider('qimanga');
        const fetchMock = vi.fn(async (_input: RequestInfo | URL) => {
            const page = fetchMock.mock.calls.length;
            return new Response(JSON.stringify({
                data: [{ slug: `chapter-${page}` }],
                totalPages: 2,
            }));
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(provider.fetchChaptersNewestFirst('series')).resolves.toEqual([
            { chapterId: 'chapter-1' },
            { chapterId: 'chapter-2' },
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe('HTML home enrichment', () => {
    it('shows Scythe home chapters first and preserves them when catalog duplicates arrive', async () => {
        vi.useFakeTimers();
        const home = `
            <div class="bixbox">
                <div class="releases"><h2>Latest Update</h2></div>
                <div class="listupd"><div class="bs"><div class="bsx">
                    <a href="https://scythescans.com/manga/series-a/"><img src="/a.webp"></a>
                    <div class="tt"><a>Series A</a></div>
                    <ul class="chfiv">
                        <li><a href="https://scythescans.com/series-a-chapter-12/"><span class="fivchap">Ch. 12</span><span class="fivtime">3 hours</span></a></li>
                        <li><a href="https://scythescans.com/series-a-chapter-11/"><span class="fivchap">Ch. 11</span><span class="fivtime">1 week</span></a></li>
                    </ul>
                </div></div></div>
            </div>`;
        const catalog = `
            <div class="listupd"><div class="bs"><div class="bsx">
                <a href="https://scythescans.com/manga/series-a/"><img src="/a.webp"></a>
                <div class="tt">Series A</div><div class="epxs">Chapter 12</div>
            </div></div></div>`;
        const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
            new Response(String(input) === 'https://scythescans.com/' ? home : catalog)
        );
        vi.stubGlobal('fetch', fetchMock);

        const opening = openHome(scythe);
        await vi.advanceTimersByTimeAsync(1_000);
        await opening;

        expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
            'https://scythescans.com/',
            'https://scythescans.com/manga/?order=update&page=1',
        ]);
        expect([...document.querySelectorAll('.hs-home-chapter')].map(chapter => ({
            label: chapter.querySelector('.hs-home-chapter-label')?.textContent,
            date: chapter.querySelector('time')?.textContent,
        }))).toEqual([
            { label: 'Chapter 12', date: '3 hours ago' },
            { label: 'Chapter 11', date: '1 week ago' },
        ]);
    });

    it('extracts Violet coin locks before continuing through its rich AJAX feed', async () => {
        const home = `
            <div class="violet-latest-comics"><div class="latest-updates">
                <div class="bs"><div class="bsx">
                    <a href="https://violetscans.org/comics/series-a/"><img src="/a.webp"></a>
                    <div class="tt">Series A</div>
                    <div class="chapter-list">
                        <a href="https://violetscans.org/series-a-chapter-3/"><div class="epxs">Chapter 3</div><i class="fas fa-coins"></i><div class="epxdate">NEW</div></a>
                        <a href="https://violetscans.org/series-a-chapter-2/"><div class="epxs">Chapter 2</div><div class="epxdate">2 days</div></a>
                        <a href="https://violetscans.org/series-a-chapter-1/"><div class="epxs">Chapter 1</div><div class="epxdate">1 week</div></a>
                        <a href="https://violetscans.org/comics/series-a/">All Chapters</a>
                    </div>
                </div></div>
            </div></div>`;
        const catalog = `
            <div class="bs"><div class="bsx">
                <a href="https://violetscans.org/comics/series-b/"><img src="/b.webp"></a>
                <div class="tt">Series B</div>
                <div class="chapter-list">
                    <a href="https://violetscans.org/series-b-chapter-1/"><div class="epxs">Chapter 1</div><div class="epxdate">3 days</div></a>
                </div>
            </div></div>`;
        const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
            new Response(String(input) === 'https://violetscans.org/' ? home : catalog)
        );
        vi.stubGlobal('fetch', fetchMock);

        await expect(violet.fetchHome(null)).resolves.toMatchObject({
            nextCursor: 'ajax:2',
            series: [{
                slug: 'series-a',
                chapters: [
                    { chapterId: '3', locked: true, uploadedAt: 'NEW' },
                    { chapterId: '2', locked: false, uploadedAt: '2 days ago' },
                    { chapterId: '1', locked: false, uploadedAt: '1 week ago' },
                ],
            }],
        });
        await expect(violet.fetchHome('ajax:2')).resolves.toMatchObject({
            nextCursor: null,
            series: [{ slug: 'series-b', chapters: [{ chapterId: '1' }] }],
        });
        expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
            'https://violetscans.org/',
            'https://violetscans.org/wp-admin/admin-ajax.php',
        ]);
    });
});

describe('home catalog rendering', () => {
    function testProvider(fetchHome: Provider['fetchHome']): Provider {
        return {
            key: 'test',
            documentTitle: 'Test',
            matchRoute: () => ({ handler: Handler.Home }),
            fetchHome,
            fetchChapter: async () => null,
            fetchChaptersNewestFirst: async () => [],
            readerUrl: (slug, chapterId) => `https://example.test/${slug}/${chapterId}`,
            seriesUrl: slug => `https://example.test/${slug}`,
        };
    }

    it('merges later bulk chapters without downgrading rich chapter metadata', async () => {
        vi.useFakeTimers();
        const pages = new Map<string | null, HomePage>([
            [null, {
                nextCursor: 'catalog:1',
                series: [
                    {
                        slug: 'series-a',
                        title: 'Series A',
                        coverUrl: 'https://example.test/a.webp',
                        chapters: [
                            { chapterId: '3', label: 'Chapter 3', uploadedAt: '2 hours ago', locked: false, unlockAt: null },
                            { chapterId: '2', label: 'Chapter 2', uploadedAt: 'last week', locked: false, unlockAt: null },
                        ],
                    },
                    {
                        slug: 'empty',
                        title: 'Empty',
                        coverUrl: 'https://example.test/empty.webp',
                        chapters: [],
                    },
                ],
            }],
            ['catalog:1', {
                nextCursor: null,
                series: [{
                    slug: 'series-a',
                    title: 'Series A',
                    coverUrl: 'https://example.test/a.webp',
                    chapters: [
                        { chapterId: '3', label: 'Chapter 3', uploadedAt: null, locked: false, unlockAt: null },
                        { chapterId: '1', label: 'Chapter 1', uploadedAt: null, locked: false, unlockAt: null },
                    ],
                }],
            }],
        ]);
        const provider = testProvider(async cursor => pages.get(cursor)!);

        const opening = openHome(provider);
        await vi.advanceTimersByTimeAsync(1_000);
        await opening;

        const chapters = [...document.querySelectorAll('.hs-home-card[data-series-slug="series-a"] .hs-home-chapter')];
        expect(chapters.map(chapter => chapter.querySelector('.hs-home-chapter-label')?.textContent)).toEqual([
            'Chapter 3',
            'Chapter 2',
            'Chapter 1',
        ]);
        expect(chapters[0].querySelector('time')?.textContent).toBe('2 hours ago');
        expect(document.querySelector('.hs-home-card[data-series-slug="empty"] .hs-home-no-chapters')?.textContent)
            .toBe('No chapters available');
    });

    it('retries an interrupted bulk request after BFCache restoration', async () => {
        vi.useFakeTimers();
        let rejectInterrupted!: (error: Error) => void;
        const interrupted = new Promise<HomePage>((_resolve, reject) => {
            rejectInterrupted = reject;
        });
        const fetchHome = vi.fn(async (cursor: string | null): Promise<HomePage> => {
            if (cursor === null) return { series: [], nextCursor: 'catalog:1' };
            if (fetchHome.mock.calls.length === 2) return interrupted;
            return { series: [], nextCursor: null };
        });
        const opening = openHome(testProvider(fetchHome));
        await vi.advanceTimersByTimeAsync(1_000);
        window.dispatchEvent(new Event('pagehide'));
        rejectInterrupted(new Error('navigation interrupted the request'));
        await Promise.resolve();
        window.dispatchEvent(new Event('pageshow'));
        await vi.advanceTimersByTimeAsync(1_000);
        await opening;

        expect(fetchHome.mock.calls.map(([cursor]) => cursor)).toEqual([null, 'catalog:1', 'catalog:1']);
        expect(document.querySelector('.hs-home-catalog-status')?.classList.contains('hs-home-catalog-error')).toBe(false);
    });
});
