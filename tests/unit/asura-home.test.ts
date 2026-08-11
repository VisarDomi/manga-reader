// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Handler } from '../../src/provider';
import { asura } from '../../src/provider/asura';

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('Asura home catalog', () => {
    it('normalizes an API page with chapter dates and early-access state', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-10T10:00:00.000Z'));
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            data: [{
                title: 'Example Series',
                cover: 'https://cdn.example/covers/example.webp',
                public_url: '/comics/example-series-abc',
                latest_chapters: [
                    {
                        number: 12,
                        is_premium: true,
                        early_access_until: '2026-08-10T14:25:00.000Z',
                        published_at: '2026-08-10T09:00:00.000Z',
                    },
                    {
                        number: 11,
                        is_premium: false,
                        early_access_until: null,
                        published_at: '2026-08-03T09:00:00.000Z',
                    },
                ],
            }],
            meta: { total: 21, has_more: true },
        })));
        vi.stubGlobal('fetch', fetchMock);

        await expect(asura.fetchHome('2')).resolves.toEqual({
            total: 21,
            nextCursor: '3',
            series: [{
                slug: 'example-series-abc',
                title: 'Example Series',
                coverUrl: 'https://cdn.example/covers/example-400.webp',
                chapters: [
                    {
                        chapterId: '12',
                        label: 'Chapter 12',
                        uploadedAt: '2026-08-10T09:00:00.000Z',
                        locked: true,
                        unlockAt: '2026-08-10T14:25:00.000Z',
                    },
                    {
                        chapterId: '11',
                        label: 'Chapter 11',
                        uploadedAt: '2026-08-03T09:00:00.000Z',
                        locked: false,
                        unlockAt: null,
                    },
                ],
            }],
        });
        expect(String(fetchMock.mock.calls[0][0])).toContain('sort=latest');
        expect(String(fetchMock.mock.calls[0][0])).toContain('limit=50');
        expect(String(fetchMock.mock.calls[0][0])).toContain('offset=50');
    });

    it('takes over only the exact home path', () => {
        expect(asura.matchRoute('/', '')).toEqual({ handler: Handler.Home });
        expect(asura.matchRoute('/browse', '')).toBeNull();
    });
});
