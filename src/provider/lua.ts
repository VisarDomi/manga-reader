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

const CHAPTER_RE = /^\/series\/([^/]+)\/(chapter-\d+)\/?$/;
const DOMAIN = SITE_CONFIG['luacomic'].domain;
const API_BASE = `https://api.${DOMAIN}`;

interface LuaHomeChapter {
    chapter_name: string;
    chapter_slug: string;
    created_at: string;
    index?: string;
}

interface LuaHomeSeries {
    title: string;
    series_slug: string;
    thumbnail: string;
    paid_chapters: LuaHomeChapter[];
    free_chapters: LuaHomeChapter[];
}

function luaChapterNumber(chapter: LuaHomeChapter): number {
    const value = chapter.index ?? chapter.chapter_name.match(/[\d.]+/)?.[0] ?? '';
    const number = Number(value);
    return Number.isFinite(number) ? number : Number.NEGATIVE_INFINITY;
}

export const lua: Provider = {
    key: 'luacomic',
    documentTitle: SITE_CONFIG.luacomic.documentTitle,

    matchRoute(pathname: string, hash: string): RouteMatch | null {
        if (pathname === '/') return { handler: Handler.Home };
        const m = CHAPTER_RE.exec(pathname);
        if (!m) return null;
        return { handler: Handler.Reader, slug: m[1], chapterId: m[2], imageIndex: hashImageIndex(hash) };
    },

    async fetchHome(cursor: string | null): Promise<HomePage> {
        if (cursor !== null) throw new Error(`Invalid Lua home cursor: ${cursor}`);
        const query = new URLSearchParams({
            page: '1',
            perPage: '1000',
            series_type: 'Comic',
            query_string: '',
            orderBy: 'latest',
            adult: 'true',
            status: 'All',
            tags_ids: '[]',
        });
        const res = await fetch(`${API_BASE}/query?${query}`);
        if (!res.ok) throw new Error(`Series catalog failed: ${res.status}`);
        const data = await res.json() as { meta: { total: number }; data: LuaHomeSeries[] };
        return {
            total: data.meta.total,
            nextCursor: null,
            series: data.data.map(series => {
                const chapters = [
                    ...series.paid_chapters.map(chapter => ({ chapter, locked: true })),
                    ...series.free_chapters.map(chapter => ({ chapter, locked: false })),
                ].sort((left, right) => luaChapterNumber(right.chapter) - luaChapterNumber(left.chapter));
                return {
                    slug: series.series_slug,
                    title: series.title,
                    coverUrl: series.thumbnail,
                    chapters: chapters.slice(0, 5).map(({ chapter, locked }) => ({
                        chapterId: chapter.chapter_slug,
                        label: chapter.chapter_name.replace(/\s+/g, ' ').trim(),
                        uploadedAt: chapter.created_at,
                        locked,
                        unlockAt: null,
                    })),
                };
            }),
        };
    },


    async fetchChapter(slug: string, chapterId: string): Promise<ChapterData | null> {
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
            seriesTitle: seriesTitle,
            images,
        };
    },

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
