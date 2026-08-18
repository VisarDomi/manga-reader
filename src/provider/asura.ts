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
import { fetchAsuraHome } from './asura-catalog';
import { lastImageIndexFrom, percentImageIndexFrom } from './resume';

const CHAPTER_RE = /^\/comics\/([^/]+)\/chapter\/(\d+)/;
const DOMAIN = SITE_CONFIG.asurascans.domain;
const API_BASE = SITE_CONFIG.asurascans.apiBase!;

/** The site rotates a trailing hex hash on frontend URL slugs; the API slug
 * (and stable local-history identity) is the slug without it. */
const HEX_SUFFIX = /-[0-9a-f]{8}$/i;

export function asuraHistoryId(slug: string): string {
    return slug.replace(HEX_SUFFIX, '');
}

async function fetchAsuraChapter(slug: string, chapterId: string): Promise<ChapterData | null> {
    const res = await fetch(`${API_BASE}/series/${slug}/chapters/${chapterId}`);
    if (isChapterUnavailable(res)) return null;
    const response = await res.json() as { data: AsuraChapterResponse };
    const data = response.data;
    if (data.is_locked) return null;

    const images: ChapterImage[] = data.chapter.pages.map(page => ({
        url: page.url,
        width: page.width,
        height: page.height,
    }));
    if (images.length === 0) throw new Error('Chapter response contained no images');
    return {
        chapterId,
        seriesSlug: slug,
        historyId: asuraHistoryId(slug),
        seriesTitle: data.series.title,
        seriesApiId: data.series.id,
        chapterApiId: data.chapter.id,
        images,
    };
}

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
    is_locked: boolean;
}

export const asura: Provider = {
    key: 'asurascans',
    catalogInWorker: true,
    remoteHistoryInWorker: true,
    documentTitle: SITE_CONFIG.asurascans.documentTitle,

    matchRoute(pathname: string, hash: string): RouteMatch | null {
        if (pathname === '/') return { handler: Handler.Home };
        const match = CHAPTER_RE.exec(pathname);
        if (!match) return null;
        return {
            handler: Handler.Reader,
            slug: match[1],
            chapterId: match[2],
            imageIndex: hashImageIndex(hash),
        };
    },

    async fetchHome(cursor: string | null): Promise<HomePage> {
        return fetchAsuraHome(cursor);
    },

    async fetchChapter(slug: string, chapterId: string): Promise<ChapterData | null> {
        return fetchAsuraChapter(slug, chapterId);
    },

    lastReadImageIndex: lastImageIndexFrom(fetchAsuraChapter),
    resumeImageIndex: percentImageIndexFrom(fetchAsuraChapter),

    async fetchChaptersNewestFirst(slug: string): Promise<ChapterMeta[]> {
        const res = await fetch(`${API_BASE}/series/${slug}/chapters`);
        if (!res.ok) throw new Error(`Chapter list failed: ${res.status}`);
        const response = await res.json() as { data: Array<{ id?: number; number: number }> };
        return response.data.map(chapter => ({
            chapterId: String(chapter.number),
            chapterApiId: chapter.id,
        }));
    },

    readerUrl(slug: string, chapterId: string, imageIndex?: string): string {
        return `https://${DOMAIN}/comics/${slug}/chapter/${chapterId}${imageIndex ? `#${imageIndex}` : ''}`;
    },

    seriesUrl(slug: string): string {
        return `https://${DOMAIN}/comics/${slug}`;
    },

};