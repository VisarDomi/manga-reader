// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAsuraHome, fetchAsuraReadHistory } from '../../src/provider/asura';

type SerializedPrimitive = [0] | [0, unknown];

function primitive(value?: unknown): SerializedPrimitive {
    return value === undefined ? [0] : [0, value];
}

function serializedChapter(overrides: Record<string, unknown> = {}): [0, Record<string, SerializedPrimitive>] {
    const fields: Record<string, unknown> = {
        name: '12',
        number: 12,
        published_at: '2026-08-10T10:00:00.000Z',
        time_ago: 'Just now',
        comic_name: 'Example Series',
        comic_slug: 'example-series',
        comic_public_url: '/comics/example-series-abc',
        comic_cover: 'https://cdn.example/covers/example.webp',
        is_premium: false,
        early_access_until: null,
        is_pinned: false,
        ...overrides,
    };
    return [0, Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, primitive(value)]))];
}

function homeHtml(chapters: Array<[0, Record<string, SerializedPrimitive>]>): string {
    const props = JSON.stringify({ chapters: [1, chapters] })
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
    return `<astro-island component-url="/_astro/LatestUpdates.hash.js" props="${props}"></astro-island>`;
}

afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('Asura home', () => {
    it('extracts the complete serialized feed with lock state and no pagination', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-10T10:00:00.000Z'));
        const html = homeHtml([
            serializedChapter({
                name: '12',
                number: 12,
                early_access_until: '2026-08-10T14:25:00.000Z',
                is_premium: true,
            }),
            serializedChapter({ name: '11', number: 11, time_ago: 'last week' }),
            serializedChapter({ name: '10', number: 10, time_ago: '2 weeks ago' }),
            serializedChapter({
                name: '3',
                number: 3,
                comic_name: 'Second Series',
                comic_slug: 'second-series',
                comic_public_url: '/comics/second-series-def',
                comic_cover: 'https://cdn.example/covers/second.webp',
                published_at: '2026-08-09T10:00:00.000Z',
            }),
            serializedChapter({
                name: '2',
                number: 2,
                comic_name: 'Second Series',
                comic_slug: 'second-series',
                comic_public_url: '/comics/second-series-def',
                comic_cover: 'https://cdn.example/covers/second.webp',
                published_at: '2026-08-08T10:00:00.000Z',
            }),
            serializedChapter({
                name: '1',
                number: 1,
                comic_name: 'Second Series',
                comic_slug: 'second-series',
                comic_public_url: '/comics/second-series-def',
                comic_cover: 'https://cdn.example/covers/second.webp',
                published_at: '2026-08-07T10:00:00.000Z',
            }),
        ]);
        const fetchMock = vi.fn(async () => new Response(html));
        vi.stubGlobal('fetch', fetchMock);

        const home = await fetchAsuraHome();

        expect(String(fetchMock.mock.calls[0][0])).toBe('https://asurascans.com/');
        expect(home.title).toBe('Latest Updates');
        expect(home.series).toHaveLength(2);
        expect(home.series[0]).toEqual({
            slug: 'example-series-abc',
            historySlug: 'example-series',
            title: 'Example Series',
            coverUrl: 'https://cdn.example/covers/example-400.webp',
            chapters: [
                {
                    chapterId: '12',
                    chapterNumber: 12,
                    label: 'Chapter 12',
                    uploadedAt: 'Just now',
                    locked: true,
                    read: false,
                    unlockAt: '2026-08-10T14:25:00.000Z',
                },
                {
                    chapterId: '11',
                    chapterNumber: 11,
                    label: 'Chapter 11',
                    uploadedAt: 'last week',
                    locked: false,
                    read: false,
                    unlockAt: null,
                },
                {
                    chapterId: '10',
                    chapterNumber: 10,
                    label: 'Chapter 10',
                    uploadedAt: '2 weeks ago',
                    locked: false,
                    read: false,
                    unlockAt: null,
                },
            ],
        });
    });

    it('fails loudly when serialized chapter data is missing a required field', async () => {
        const broken = serializedChapter();
        delete broken[1].time_ago;
        vi.stubGlobal('fetch', vi.fn(async () => new Response(homeHtml([
            broken,
            serializedChapter({ name: '11', number: 11 }),
            serializedChapter({ name: '10', number: 10 }),
        ]))));

        await expect(fetchAsuraHome()).rejects.toThrow('home chapter 0 is missing time_ago');
    });

    it('loads authenticated server history independently from the public feed', async () => {
        localStorage.setItem('access_token', 'test-token');
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            data: {
                'example-series': 11,
                'second-series': ['2', 3],
            },
        })));
        vi.stubGlobal('fetch', fetchMock);

        const history = await fetchAsuraReadHistory();

        expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.asurascans.com/api/me/read-chapters');
        const init = fetchMock.mock.calls[0][1];
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-token');
        expect([...history]).toEqual([
            ['example-series', 11],
            ['second-series', 3],
        ]);
    });

    it('does not request history for a signed-out visitor', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchAsuraReadHistory()).resolves.toEqual(new Map());
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
