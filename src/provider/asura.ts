import type { Provider, RouteMatch, ChapterData, ChapterMeta, ChapterImage } from './types';
import { Handler } from './types';
import { SITE_CONFIG } from '../core/sites';
import { isChapterUnavailable } from '../core/http';

const CHAPTER_RE = /^\/comics\/([^/]+)\/chapter\/(\d+)/;
const DOMAIN = SITE_CONFIG['asurascans'].domain;
const API_BASE = SITE_CONFIG['asurascans'].apiBase!;

interface AsuraPage {
    url: string;
    width: number;
    height: number;
}

interface AsuraChapterResponse {
    chapter: {
        id: number;
        series_id: number;
        number: number;
        pages: AsuraPage[];
    };
    series: {
        id: number;
        title: string;
        cover: string;
    };
    prev_chapter: { number: number } | null;
    next_chapter: { number: number } | null;
    is_locked: boolean;
}

export const asura: Provider = {

    matchRoute(pathname: string): RouteMatch | null {
        const m = CHAPTER_RE.exec(pathname);
        if (!m) return null;
        return { handler: Handler.Reader, slug: m[1], chapter: m[2] };
    },


    async fetchChapter(slug: string, chapterId: string): Promise<ChapterData | null> {
        const res = await fetch(`${API_BASE}/series/${slug}/chapters/${chapterId}`);
        if (isChapterUnavailable(res)) return null;
        const json = await res.json() as { data: AsuraChapterResponse };
        const data = json.data;

        if (data.is_locked) return null;

        const pages = data.chapter.pages;
        const images: ChapterImage[] = pages.map(p => ({
            url: p.url,
            width: p.width,
            height: p.height,
        }));

        return {
            chapterId,
            seriesTitle: data.series.title,
            seriesApiId: data.series.id,
            chapterApiId: data.chapter.id,
            images,
        };
    },

    async fetchChapterList(slug: string): Promise<ChapterMeta[]> {
        const res = await fetch(`${API_BASE}/series/${slug}/chapters`);
        if (!res.ok) throw new Error(`Chapter list failed: ${res.status}`);
        const json = await res.json() as { data: Array<{ number: number }> };
        return (json.data).map(ch => ({ chapterId: String(ch.number) }));
    },

    readerUrl(_slug: string, chapterId: string, imgIdx?: string): string {
        return `https://${DOMAIN}/comics/${_slug}/chapter/${chapterId}${imgIdx ? `#${imgIdx}` : ''}`;
    },

    seriesUrl(slug: string): string {
        return `https://${DOMAIN}/comics/${slug}`;
    },

    getNextChapter(chapterList: ChapterMeta[], lastChapter: string): ChapterMeta {
        const idx = chapterList.findIndex(m => m.chapterId === lastChapter);
        return chapterList[idx - 1];
    },

    async trackChapter(data: ChapterData): Promise<void> {
        if (!data.seriesApiId || !data.chapterApiId) return;
        const token = globalThis.localStorage?.getItem('access_token');
        if (!token) return;
        const headers = {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        };
        void fetch(`${API_BASE}/bookmarks/${data.seriesApiId}/read/${data.chapterId}`, { method: 'POST', headers })
        void fetch(`${API_BASE}/views/chapter`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ chapter_id: data.chapterApiId, series_id: data.seriesApiId }),
        })
    },
};
