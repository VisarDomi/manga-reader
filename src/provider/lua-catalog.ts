// Worker-safe catalog fetch for luacomic. No DOM.
import { SITE_CONFIG } from '../core/sites';
import type { HomePage } from './types';

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

// Lua's API answers an uncached catalog query in time that grows steeply with its
// size (October 6: 100 series 0.3 s, 1000 series 5.1 s), and its cache expires
// between launches. Home shows the newest 100 at once, then the whole catalog
// from one response: offset pages are not used because many series share a sort
// key, and their order changes between requests (pages skipped and repeated rows).
const LUA_FIRST_PAGE_SIZE = 100;
const LUA_CATALOG_PAGE_SIZE = 1000;

export async function fetchLuaHome(cursor: string | null, referrer?: string): Promise<HomePage> {
    const match = cursor === null ? null : /^all:(\d+)$/.exec(cursor);
    const page = match === null ? 1 : Number(match[1]);
    if ((cursor !== null && match === null) || !Number.isSafeInteger(page) || page < 1) {
        throw new Error(`Invalid Lua home cursor: ${cursor}`);
    }
    const query = new URLSearchParams({
        page: String(page),
        perPage: String(cursor === null ? LUA_FIRST_PAGE_SIZE : LUA_CATALOG_PAGE_SIZE),
        series_type: 'Comic',
        query_string: '',
        orderBy: 'latest',
        adult: 'true',
        status: 'All',
        tags_ids: '[]',
    });
    const res = await fetch(`${API_BASE}/query?${query}`, referrer ? { referrer } : undefined);
    if (!res.ok) throw new Error(`Series catalog failed: ${res.status}`);
    const data = await res.json() as { meta: { total: number; last_page: number }; data: LuaHomeSeries[] };
    const nextCursor = cursor === null
        ? (data.meta.total > data.data.length ? 'all:1' : null)
        : (page < data.meta.last_page ? `all:${page + 1}` : null);
    return {
        total: data.meta.total,
        nextCursor,
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
}
