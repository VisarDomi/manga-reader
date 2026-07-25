import type { Provider, RouteMatch, ChapterData, ChapterMeta, ChapterImage } from './types';
import { Handler } from './types';
import { SITE_CONFIG } from '../sites';

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
        pages: AsuraPage[] | null;
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


    async fetchChapter(slug: string, chapterId: string): Promise<ChapterData> {
        const res = await fetch(`${API_BASE}/series/${slug}/chapters/${chapterId}`);
        if (!res.ok) throw new Error(`Chapter not found: ${res.status}`);
        const json = await res.json() as { data: AsuraChapterResponse };
        const data = json.data;

        if (data.is_locked) throw new Error('Chapter is locked');

        const pages = data.chapter.pages ?? [];
        const images: ChapterImage[] = pages.map((p, i) => ({
            url: p.url,
            order: i,
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
        return (json.data ?? []).map(ch => ({ slug: String(ch.number) }));
    },

    readerUrl(_slug: string, chapterId: string, imgIdx?: string): string {
        return `https://${DOMAIN}/comics/${_slug}/chapter/${chapterId}${imgIdx ? `#${imgIdx}` : ''}`;
    },

    seriesUrl(slug: string): string {
        return `https://${DOMAIN}/comics/${slug}`;
    },

    getNextChapter(chapterList: ChapterMeta[], lastChapter: string): ChapterMeta {
        const idx = chapterList.findIndex(m => m.slug === lastChapter);
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
        fetch(`${API_BASE}/bookmarks/${data.seriesApiId}/read/${data.chapterId}`, { method: 'POST', headers }).catch(() => {});
        fetch(`${API_BASE}/views/chapter`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ chapter_id: data.chapterApiId, series_id: data.seriesApiId }),
        }).catch(() => {});
    },
};
