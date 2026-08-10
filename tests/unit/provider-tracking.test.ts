import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChapterData, ChapterMeta } from '../../src/provider';
import { asura } from '../../src/provider/asura';
import { valir } from '../../src/provider/valir';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('Valir tracking', () => {
    it('sends page progress and marks older chapters complete', async () => {
        const fetchMock = vi.fn(async () => new Response());
        vi.stubGlobal('fetch', fetchMock);
        const data: ChapterData = {
            chapterId: '11',
            chapterApiId: 'chapter-api-11',
            seriesApiId: 'series-api',
            seriesTitle: 'Series',
            images: [
                { url: 'page-1' },
                { url: 'page-2' },
                { url: 'page-3' },
                { url: 'page-4' },
            ],
        };
        const chapters: ChapterMeta[] = [
            { chapterId: '12', chapterApiId: 'chapter-api-12' },
            { chapterId: '11', chapterApiId: 'chapter-api-11' },
            { chapterId: '10', chapterApiId: 'chapter-api-10' },
            { chapterId: '9' },
        ];

        await valir.trackPage?.(data, '1', chapters);

        expect(fetchMock).toHaveBeenCalledOnce();
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toContain('/api/chapters/reading-position');
        expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
        expect(JSON.parse(String(init?.body))).toEqual({
            seriesId: 'series-api',
            chapters: [
                { chapterId: 'chapter-api-11', progress: 50 },
                { chapterId: 'chapter-api-10', progress: 100 },
            ],
        });
    });
});

describe('Asura tracking', () => {
    it('sends one history request and one chapter-view request', async () => {
        const fetchMock = vi.fn(async () => new Response());
        vi.stubGlobal('fetch', fetchMock);
        vi.stubGlobal('localStorage', { getItem: vi.fn(() => 'token') });
        const data: ChapterData = {
            chapterId: '7',
            chapterApiId: 70,
            seriesApiId: 5,
            seriesTitle: 'Series',
            images: [{ url: 'page-1' }],
        };

        await asura.trackChapter?.(data);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(String(fetchMock.mock.calls[0][0])).toContain('/bookmarks/5/read/7');
        expect(String(fetchMock.mock.calls[1][0])).toContain('/views/chapter');
        expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
            chapter_id: 70,
            series_id: 5,
        });
    });
});
