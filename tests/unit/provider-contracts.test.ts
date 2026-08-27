// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    ChapterLoadIntent,
    ChapterLoadResultKind,
    type ChapterData,
    type Provider,
} from '../../src/provider';
import { lua } from '../../src/provider/lua';
import { scythe } from '../../src/provider/scythe';
import { defaultReaderImages } from '../../src/provider/ts-reader';
import { violet } from '../../src/provider/violet';
import { yaksha } from '../../src/provider/yaksha';

afterEach(() => vi.unstubAllGlobals());

async function loadChapter(provider: Provider, slug: string, chapterId: string): Promise<ChapterData> {
    const result = await provider.loadChapter({ slug, chapterId, intent: ChapterLoadIntent.Open });
    if (result.kind !== ChapterLoadResultKind.Chapter) {
        throw new Error(`Expected chapter result, received ${ChapterLoadResultKind[result.kind]}`);
    }
    return result.data;
}

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

describe('series title contracts', () => {
    it('requires Scythe .allc metadata', async () => {
        const reader = btoa('ts_reader.run({"defaultSource":"Server 1","sources":[{"source":"Server 1","images":["one.webp"]}]});');
        vi.stubGlobal('fetch', vi.fn(async () => new Response(
            `<script defer src="data:text/javascript;base64,${reader}"></script>`,
        )));
        await expect(loadChapter(scythe, 'series', 'series-chapter-1'))
            .rejects.toThrow('series title');
    });

    it('requires Violet HISTORY metadata', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(
            '<div class="allc"><a href="https://violetscans.org/comics/series/">Series</a></div>'
            + '<script>ts_reader.run({"defaultSource":"Server 1","sources":[{"source":"Server 1","images":["one.webp"]}]});</script>',
        )));
        await expect(loadChapter(violet, 'series', '1')).rejects.toThrow('history data');
    });

    it('keeps Violet canonical series slugs when chapter permalinks use an alias', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(`
            <div class="allc"><a href="https://violetscans.org/comics/canonical-series/">Series</a></div>
            <script>ts_reader.run({"defaultSource":"Server 1","sources":[{"source":"Server 1","images":["one.webp"]}]});</script>
            <script>HISTORY.push(1, {"manga_title":"Canonical Series"});</script>
        `)));

        await expect(loadChapter(violet, 'old-series-name', '7')).resolves.toMatchObject({
            chapterId: '7',
            seriesSlug: 'canonical-series',
            seriesTitle: 'Canonical Series',
        });
        expect(violet.seriesUrl('old-series-name')).toBe(
            'https://violetscans.org/comics/canonical-series/',
        );
        expect(violet.readerUrl('canonical-series', '7')).toBe(
            'https://violetscans.org/old-series-name-chapter-7/',
        );
    });

    it('rejects missing or ambiguous Violet chapter series identity', async () => {
        const chapterPayload = `
            <script>ts_reader.run({"defaultSource":"Server 1","sources":[{"source":"Server 1","images":["one.webp"]}]});</script>
            <script>HISTORY.push(1, {"manga_title":"Series"});</script>
        `;
        const fetchMock = vi.fn(async () => new Response(chapterPayload));
        vi.stubGlobal('fetch', fetchMock);
        await expect(loadChapter(violet, 'missing-series-identity', '1'))
            .rejects.toThrow('did not contain a Violet series URL');

        fetchMock.mockResolvedValue(new Response(`
            <div class="allc">
                <a href="https://violetscans.org/comics/series-one/">One</a>
                <a href="https://violetscans.org/comics/series-two/">Two</a>
            </div>
            ${chapterPayload}
        `));
        await expect(loadChapter(violet, 'ambiguous-series-identity', '1'))
            .rejects.toThrow('ambiguous Violet series URLs');
    });

    it('validates Violet available and locked chapter-list entries explicitly', async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            if (String(input).includes('/comics/')) {
                return new Response(`
                    <div id="chapterlist"><ul>
                        <li data-num="3"><a data-bs-target="#lockedChapterModal" data-id="30" data-coin="50">Locked</a></li>
                        <li data-num="2"><a href="https://violetscans.org/old-list-name-chapter-2/">Chapter 2</a></li>
                    </ul></div>
                `);
            }
            return new Response(`
                <div class="allc"><a href="https://violetscans.org/comics/canonical-list-series/">Series</a></div>
                <script>ts_reader.run({"defaultSource":"Server 1","sources":[{"source":"Server 1","images":["one.webp"]}]});</script>
                <script>HISTORY.push(1, {"manga_title":"Series"});</script>
            `);
        });
        vi.stubGlobal('fetch', fetchMock);

        await loadChapter(violet, 'old-list-name', '1');
        await expect(violet.fetchChaptersNewestFirst('canonical-list-series')).resolves.toEqual([
            { chapterId: '2' },
        ]);
        expect(violet.readerUrl('canonical-list-series', '2')).toBe(
            'https://violetscans.org/old-list-name-chapter-2/',
        );

        fetchMock.mockResolvedValue(new Response(`
            <div id="chapterlist"><ul><li data-num="4"><a>Malformed</a></li></ul></div>
        `));
        await expect(violet.fetchChaptersNewestFirst('canonical-list-series'))
            .rejects.toThrow('neither a URL nor lock metadata');
    });

    it('requires Lua title metadata', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(
            '<img src="https://media.luacomic.org/file/a/uploads/series/one.webp">',
        )));
        await expect(loadChapter(lua, 'series', 'chapter-1')).rejects.toThrow('series title');
    });

    it('requires Yaksha breadcrumb metadata', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(
            '<img class="wp-manga-chapter-img" src="https://example.test/one.webp">',
        )));
        await expect(loadChapter(yaksha, 'series', 'chapter-1')).rejects.toThrow('series title');
    });
});
