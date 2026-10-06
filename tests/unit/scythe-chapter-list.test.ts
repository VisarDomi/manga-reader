// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { scythe } from '../../src/provider/scythe';

const SLUG = 'my-disciples-are-all-big-villains';
const id = (chapter: number) => `${SLUG}-chapter-${chapter}`;
const url = (path: string) => `https://scythescans.com/${path}`;

function seriesPage(chapters: number[]): string {
    const links = chapters.map(chapter => `<li><a href="${url(id(chapter))}/">Chapter ${chapter}</a></li>`);
    return `<div id="chapterlist"><ul>${links.join('')}</ul></div>`;
}

function homePage(chapters: number[]): string {
    const latest = chapters.map(chapter =>
        `<li><a href="${url(id(chapter))}/">Chapter ${chapter}<span class="fivtime">2 hours</span></a></li>`);
    return `<div class="bixbox"><div class="releases"><h2>Latest Update</h2></div><div class="listupd">
        <div class="bs"><div class="bsx"><a href="${url(`manga/${SLUG}/`)}"><img src="${url('cover.webp')}">
        <div class="tt">My Disciples</div></a></div><ul class="chfiv">${latest.join('')}</ul></div></div></div>`;
}

function chapterPage(chapter: number, previous: number | null): string {
    const run = `ts_reader.run(${JSON.stringify({
        prevUrl: previous === null ? '' : `${url(id(previous))}/`,
        nextUrl: '',
        defaultSource: 'Server 1',
        sources: [{ source: 'Server 1', images: [url(`${chapter}.webp`)] }],
    })});`;
    return `<script defer src="data:text/javascript;base64,${btoa(run)}"></script>
        <div class="allc">All chapters are in <a href="${url(`manga/${SLUG}/`)}">My Disciples</a></div>`;
}

let pages: Map<string, string>;
const fetched: string[] = [];

beforeEach(() => {
    pages = new Map();
    fetched.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
        fetched.push(input);
        if (pages.get(input) === 'slow') {
            return new Promise<Response>((_, reject) => {
                init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
            });
        }
        const body = pages.get(input);
        return new Response(body ?? 'Not found', { status: body === undefined ? 404 : 200 });
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

function serve(listed: number[], latest: number[], previous: Record<number, number | null> = {}): void {
    pages.set(url(`manga/${SLUG}/`), seriesPage(listed));
    pages.set(url(''), homePage(latest));
    for (const [chapter, prev] of Object.entries(previous)) {
        pages.set(url(`${id(Number(chapter))}/`), chapterPage(Number(chapter), prev));
    }
}

const ids = (chapters: { chapterId: string }[]) => chapters.map(chapter => chapter.chapterId);

it('reads only cached pages: never an uncached query-string URL', async () => {
    serve([563, 562, 561], [563, 562]);
    expect(ids(await scythe.fetchChaptersNewestFirst(SLUG))).toEqual([563, 562, 561].map(id));
    expect(fetched.every(requested => !requested.includes('?'))).toBe(true);
});

it('adds a chapter the stale cached series page omits but Latest Update shows', async () => {
    serve([562, 561], [563, 562]);
    expect(ids(await scythe.fetchChaptersNewestFirst(SLUG))).toEqual([563, 562, 561].map(id));
});

it('fills chapters between Latest Update and an older cached list through previous links', async () => {
    serve([560, 559], [563, 562], { 562: 561, 561: 560 });
    expect(ids(await scythe.fetchChaptersNewestFirst(SLUG))).toEqual([563, 562, 561, 560, 559].map(id));
});

it('keeps the cached list rather than return one with a hole', async () => {
    serve([560, 559], [563, 562], { 562: null });
    expect(ids(await scythe.fetchChaptersNewestFirst(SLUG))).toEqual([560, 559].map(id));
});

it('uses the cached list when Latest Update fails or does not show the series', async () => {
    serve([562, 561], []);
    pages.set(url(''), homePage([]).replace(`manga/${SLUG}/`, 'manga/another-series/'));
    expect(ids(await scythe.fetchChaptersNewestFirst(SLUG))).toEqual([562, 561].map(id));
    pages.delete(url(''));
    expect(ids(await scythe.fetchChaptersNewestFirst(SLUG))).toEqual([562, 561].map(id));
});

it('gives up filling a gap through slow uncached chapter pages', async () => {
    vi.useFakeTimers();
    try {
        serve([560, 559], [563, 562]);
        pages.set(url(`${id(562)}/`), 'slow');
        const list = scythe.fetchChaptersNewestFirst(SLUG);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(ids(await list)).toEqual([560, 559].map(id));
    } finally {
        vi.useRealTimers();
    }
});
