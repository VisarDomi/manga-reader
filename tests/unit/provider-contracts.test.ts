// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { lua } from '../../src/provider/lua';
import { scythe } from '../../src/provider/scythe';
import { defaultReaderImages } from '../../src/provider/ts-reader';
import { parseValirChapters, valir } from '../../src/provider/valir';
import { violet } from '../../src/provider/violet';
import { yaksha } from '../../src/provider/yaksha';

afterEach(() => vi.unstubAllGlobals());

describe('ts_reader source selection', () => {
    it('uses the declared default source rather than array order', () => {
        expect(defaultReaderImages({
            defaultSource: 'Server 1',
            sources: [
                { source: 'Server 2', images: ['wrong.webp'] },
                { source: 'Server 1', images: ['one.webp', 'two.webp'] },
            ],
        })).toEqual(['one.webp', 'two.webp']);
    });

    it('rejects an ambiguous default source', () => {
        expect(() => defaultReaderImages({
            defaultSource: 'Server 1',
            sources: [
                { source: 'Server 1', images: ['one.webp'] },
                { source: 'Server 1', images: ['two.webp'] },
            ],
        })).toThrow('matched 2 sources');
    });
});

describe('Valir chapter contract', () => {
    it('reassembles flight chunks and parses the complete chapter array', () => {
        const chunks = [
            '64:[{"allChap',
            'ters":[{"id":"chapter-one","number":1},{"id":"chapter-two","number":2}]}]\n',
        ];
        const html = chunks.map(chunk =>
            `<script>self.__next_f.push(${JSON.stringify([1, chunk])})</script>`
        ).join('');

        expect(parseValirChapters(html)).toEqual([
            { chapterId: '2', chapterApiId: 'chapter-two' },
            { chapterId: '1', chapterApiId: 'chapter-one' },
        ]);
    });

    it('rejects duplicate or unordered chapters instead of silently deduplicating them', () => {
        const chunk = '1:{"allChapters":[{"id":"a","number":2},{"id":"b","number":2}]}';
        const html = `<script>self.__next_f.push(${JSON.stringify([1, chunk])})</script>`;
        expect(() => parseValirChapters(html)).toThrow('not uniquely ordered');
    });

    it('requests the manga-only catalog recorded in test.txt', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            data: [],
            meta: { total: 0, hasMore: false },
        })));
        vi.stubGlobal('fetch', fetchMock);

        await valir.fetchHome('2');

        const url = new URL(String(fetchMock.mock.calls[0][0]));
        expect(url.searchParams.get('type')).toBe('MANHWA,MANHUA,MANGA,WEBTOON');
        expect(url.searchParams.get('page')).toBe('2');
    });
});

describe('series title contracts', () => {
    it('requires Scythe .allc metadata', async () => {
        const reader = btoa('ts_reader.run({"defaultSource":"Server 1","sources":[{"source":"Server 1","images":["one.webp"]}]});');
        vi.stubGlobal('fetch', vi.fn(async () => new Response(
            `<script defer src="data:text/javascript;base64,${reader}"></script>`,
        )));
        await expect(scythe.fetchChapter('series', 'series-chapter-1'))
            .rejects.toThrow('series title');
    });

    it('requires Violet HISTORY metadata', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(
            '<script>ts_reader.run({"defaultSource":"Server 1","sources":[{"source":"Server 1","images":["one.webp"]}]});</script>',
        )));
        await expect(violet.fetchChapter('series', '1')).rejects.toThrow('history data');
    });

    it('requires Lua title metadata', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(
            '<img src="https://media.luacomic.org/file/a/uploads/series/one.webp">',
        )));
        await expect(lua.fetchChapter('series', 'chapter-1')).rejects.toThrow('series title');
    });

    it('requires Yaksha breadcrumb metadata', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(
            '<img class="wp-manga-chapter-img" src="https://example.test/one.webp">',
        )));
        await expect(yaksha.fetchChapter('series', 'chapter-1')).rejects.toThrow('series title');
    });
});
