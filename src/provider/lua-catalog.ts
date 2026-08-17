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

export async function fetchLuaHome(cursor: string | null, referrer?: string): Promise<HomePage> {
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
    const res = await fetch(`${API_BASE}/query?${query}`, referrer ? { referrer } : undefined);
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
}
