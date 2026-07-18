import type { Provider, RouteMatch, ChapterData, ChapterMeta, ChapterImage } from './types';
import { Handler } from './types';
import { Site, SITE_CONFIG } from '../sites';

const CHAPTER_RE = /^\/comics\/([^/]+)\/chapter\/(\d+)/;
const DOMAIN = SITE_CONFIG[Site.AsuraScans].domain;
const API_BASE = SITE_CONFIG[Site.AsuraScans].apiBase!;

interface AsuraPage {
    url: string;
    width: number;
    height: number;
}

interface AsuraChapterResponse {
    chapter: {
        number: number;
        pages: AsuraPage[] | null;
    };
    series: {
        title: string;
        cover: string;
    };
    prev_chapter: { number: number } | null;
    next_chapter: { number: number } | null;
    is_locked: boolean;
}

export const asura: Provider = {
    name: Site.AsuraScans,

    matchRoute(pathname: string): RouteMatch | null {
        const m = CHAPTER_RE.exec(pathname);
        if (!m) return null;
        return { handler: Handler.Reader, slug: m[1], chapter: m[2] };
    },

    async init(): Promise<void> { /* no-op */ },

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
            slug,
            number: data.chapter.number,
            title: null,
            content: null,
            cover: data.series.cover,
            publishStatus: 'PUBLIC',
            price: 0,
            isFree: true,
            requiresPurchase: false,
            series: { title: data.series.title },
            images,
            prevUrl: data.prev_chapter
                ? `https://${DOMAIN}/comics/${slug}/chapter/${data.prev_chapter.number}`
                : null,
            nextUrl: data.next_chapter
                ? `https://${DOMAIN}/comics/${slug}/chapter/${data.next_chapter.number}`
                : null,
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
};
