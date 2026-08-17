import {
    Handler,
    type Provider,
    type RouteMatch,
    type ChapterData,
    type ChapterMeta,
    type ChapterImage,
    type HomePage,
} from './types';
import { SITE_CONFIG } from '../core/sites';
import { isChapterUnavailable } from '../core/http';
import { hashImageIndex } from '../core/page';
import { fetchLuaHome } from './lua-catalog';
import { lastImageIndexFrom, percentImageIndexFrom } from './resume';

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

export const lua: Provider = {
    key: 'luacomic',
    catalogInWorker: true,
    documentTitle: SITE_CONFIG.luacomic.documentTitle,

    matchRoute(pathname: string, hash: string): RouteMatch | null {
        if (pathname === '/') return { handler: Handler.Home };
        const m = CHAPTER_RE.exec(pathname);
        if (!m) return null;
        return { handler: Handler.Reader, slug: m[1], chapterId: m[2], imageIndex: hashImageIndex(hash) };
    },

    async fetchHome(cursor: string | null): Promise<HomePage> {
        return fetchLuaHome(cursor);
    },


    async fetchChapter(slug: string, chapterId: string): Promise<ChapterData | null> {
        return fetchLuaChapter(slug, chapterId);
    },

    lastReadImageIndex: lastImageIndexFrom(fetchLuaChapter),
    resumeImageIndex: percentImageIndexFrom(fetchLuaChapter),

    async fetchChaptersNewestFirst(slug: string): Promise<ChapterMeta[]> {
        // Get series ID from the series API
        const seriesRes = await fetch(`${API_BASE}/series/${slug}`);
        if (!seriesRes.ok) throw new Error(`Series not found: ${seriesRes.status}`);
        const seriesData = await seriesRes.json() as { id: number };
        const seriesId = seriesData.id;

        const chapters: ChapterMeta[] = [];
        let page = 1;
        let hasMore = true;
        while (hasMore) {
            const res = await fetch(
                `${API_BASE}/chapter/query?page=${page}&perPage=100&order=desc&series_id=${seriesId}`
            );
            if (!res.ok) throw new Error(`Chapter list failed: ${res.status}`);
            const data = await res.json() as {
                meta: { total: number; last_page: number };
                data: Array<{ chapter_slug: string }>;
            };
            for (const item of data.data) {
                chapters.push({ chapterId: item.chapter_slug });
            }
            hasMore = page < data.meta.last_page;
            page++;
        }
        return chapters;
    },

    readerUrl(_slug: string, chapterId: string, imageIndex?: string): string {
        return `https://${DOMAIN}/series/${_slug}/${chapterId}${imageIndex ? `#${imageIndex}` : ''}`;
    },

    seriesUrl(slug: string): string {
        return `https://${DOMAIN}/series/${slug}`;
    },
};