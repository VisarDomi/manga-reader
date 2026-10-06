import {
    Handler,
    type Provider,
    type RouteMatch,
    type ChapterData,
    type ChapterMeta,
    type ChapterImage,
} from './types';
import { SITE_CONFIG } from '../core/sites';
import { isChapterUnavailable } from '../core/http';
import { hashImageIndex } from '../core/page';
import { chapterLoader, homeDestinationResolver, workerHome } from './actions';

const CHAPTER_RE = /^\/series\/([^/]+)\/(chapter-\d+)\/?$/;
const DOMAIN = SITE_CONFIG['luacomic'].domain;
async function fetchLuaChapter(slug: string, chapterId: string): Promise<ChapterData | null> {
    const url = `https://${DOMAIN}/series/${slug}/${chapterId}`;
    const res = await fetch(url);
    if (isChapterUnavailable(res)) return null;
    const html = await res.text();

    // Extract chapter images — <img> tags with media.luacomic.org/uploads/series/ in src
    const srcs: string[] = [];
    const imgRe = /<img\b[^>]*\bsrc="(https:\/\/media\.luacomic\.org\/file\/[^"]*\/uploads\/series\/[^"]+\.(?:webp|jpg|png)[^"]*)"[^>]*>/g;
    for (const m of html.matchAll(imgRe)) {
        srcs.push(m[1].trim().replace(/\s+/g, ''));
    }

    if (srcs.length === 0) throw new Error('Chapter response contained no images');

    const images: ChapterImage[] = srcs.map(url => ({ url }));

    // Extract series title from <title> — format: "Series Title - Chapter N - Lua Comic"
    const titleMatch = /<title>(.+?)\s+-\s+Chapter\s+\d+\s+-\s+Lua Comic<\/title>/i.exec(html);
    const seriesTitle = titleMatch?.[1].trim();
    if (!seriesTitle) throw new Error('Chapter response did not contain the series title');

    return {
        chapterId: chapterId,
        seriesSlug: slug,
        seriesTitle: seriesTitle,
        images,
    };
}
const API_BASE = `https://api.${DOMAIN}`;

// The chapter list query is slow whenever Lua's API cache has expired: about
// 3.5 s per request for 30 chapters, about 12 s for 100 (October 6). Pages use the
// website's own URL, so they are often already cached by its readers, and are
// requested together: the first four at once, any further ones after the count.
const LUA_LIST_PAGE_SIZE = 30;
const LUA_LIST_FIRST_PAGES = 4;

async function fetchLuaChapterPage(seriesId: number, page: number): Promise<{ lastPage: number; chapters: ChapterMeta[] }> {
    const query = new URLSearchParams({
        page: String(page),
        perPage: String(LUA_LIST_PAGE_SIZE),
        query: '',
        order: 'desc',
        series_id: String(seriesId),
    });
    const res = await fetch(`${API_BASE}/chapter/query?${query}`);
    if (!res.ok) throw new Error(`Chapter list failed: ${res.status}`);
    const data = await res.json() as {
        meta: { last_page: number };
        data: Array<{ chapter_slug: string }>;
    };
    return { lastPage: data.meta.last_page, chapters: data.data.map(item => ({ chapterId: item.chapter_slug })) };
}

async function fetchLuaChaptersNewestFirst(slug: string): Promise<ChapterMeta[]> {
    const seriesRes = await fetch(`${API_BASE}/series/${slug}`);
    if (!seriesRes.ok) throw new Error(`Series not found: ${seriesRes.status}`);
    const seriesData = await seriesRes.json() as { id: number };
    const pages = await Promise.all(Array.from({ length: LUA_LIST_FIRST_PAGES },
        (_, i) => fetchLuaChapterPage(seriesData.id, i + 1)));
    const lastPage = pages[0].lastPage;
    if (lastPage > LUA_LIST_FIRST_PAGES) {
        pages.push(...await Promise.all(Array.from({ length: lastPage - LUA_LIST_FIRST_PAGES },
            (_, i) => fetchLuaChapterPage(seriesData.id, LUA_LIST_FIRST_PAGES + i + 1))));
    }
    return pages.slice(0, lastPage).flatMap(page => page.chapters);
}

function luaReaderUrl(slug: string, chapterId: string, imageIndex?: string): string {
    return `https://${DOMAIN}/series/${slug}/${chapterId}${imageIndex ? `#${imageIndex}` : ''}`;
}

function luaSeriesUrl(slug: string): string {
    return `https://${DOMAIN}/series/${slug}`;
}

export const lua: Provider = {
    key: 'luacomic',

    matchRoute(pathname: string, hash: string): RouteMatch | null {
        if (pathname === '/') return { handler: Handler.Home };
        const m = CHAPTER_RE.exec(pathname);
        if (!m) return null;
        return { handler: Handler.Reader, slug: m[1], chapterId: m[2], imageIndex: hashImageIndex(hash) };
    },

    fetchHome: workerHome('luacomic'),
    loadChapter: chapterLoader(fetchLuaChapter, luaSeriesUrl),
    resolveHomeDestination: homeDestinationResolver({
        fetchChapter: fetchLuaChapter,
        fetchChaptersNewestFirst: fetchLuaChaptersNewestFirst,
        readerUrl: luaReaderUrl,
        seriesUrl: luaSeriesUrl,
    }),
    fetchChaptersNewestFirst: fetchLuaChaptersNewestFirst,
    readerUrl: luaReaderUrl,
    seriesUrl: luaSeriesUrl,
};
