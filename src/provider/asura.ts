import {
    Handler,
    type Provider,
    type RouteMatch,
    type ChapterData,
    type ChapterMeta,
    type ChapterImage,
    type HomePage,
    type RemoteSeriesHistory,
} from './types';
import { SITE_CONFIG } from '../core/sites';
import { isChapterUnavailable } from '../core/http';
import { hashImageIndex } from '../core/page';
import { createAsuraTokenManager } from './asura-token-manager';

const CHAPTER_RE = /^\/comics\/([^/]+)\/chapter\/(\d+)/;
const SERIES_RE = /^\/comics\/([^/]+)$/;
const DOMAIN = SITE_CONFIG.asurascans.domain;
const API_BASE = SITE_CONFIG.asurascans.apiBase!;
export const asuraTokenManager = createAsuraTokenManager(API_BASE);

interface AsuraHomeChapter {
    number: number;
    is_premium: boolean;
    early_access_until: string | null;
    published_at: string;
}

interface AsuraHomeSeries {
    slug: string;
    title: string;
    cover: string;
    public_url: string;
    latest_chapters: AsuraHomeChapter[];
}

function record(value: unknown, context: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`Asura ${context} is not an object`);
    }
    return value as Record<string, unknown>;
}

function historyChapter(value: unknown, historySlug: string): number {
    if (typeof value !== 'number' && typeof value !== 'string') {
        throw new Error(`Asura read history for ${historySlug} contains a non-number`);
    }
    const chapter = Number(value);
    if (!Number.isFinite(chapter) || chapter <= 0) {
        throw new Error(`Asura read history for ${historySlug} contains an invalid chapter`);
    }
    return chapter;
}

export function parseAsuraRemoteHistory(value: unknown): RemoteSeriesHistory[] {
    const envelope = record(value, 'read history response');
    if (!('data' in envelope)) throw new Error('Asura read history response is missing data');
    const data = record(envelope.data, 'read history data');
    return Object.entries(data).map(([historySlug, raw]) => {
        const values = Array.isArray(raw) ? raw : [raw];
        if (values.length === 0) throw new Error(`Asura read history for ${historySlug} is empty`);
        const latest = Math.max(...values.map(item => historyChapter(item, historySlug)));
        return {
            seriesId: historySlug,
            readThroughChapterId: String(latest),
            resumeChapterId: String(latest),
        };
    });
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

function publicSlug(publicUrl: string): string {
    const match = SERIES_RE.exec(new URL(publicUrl, `https://${DOMAIN}`).pathname);
    if (!match) throw new Error(`Invalid Asura series URL: ${publicUrl}`);
    return match[1];
}

function coverUrl(raw: string): string {
    const url = new URL(raw, `https://${DOMAIN}`);
    if (url.pathname.includes('/covers/') && url.pathname.endsWith('.webp')) {
        url.pathname = `${url.pathname.slice(0, -5)}-400.webp`;
    }
    return url.href;
}

export const asura: Provider = {
    key: 'asurascans',
    documentTitle: SITE_CONFIG.asurascans.documentTitle,
    tokenManager: asuraTokenManager,

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
        const page = cursor === null ? 1 : Number(cursor);
        if (!Number.isSafeInteger(page) || page < 1) throw new Error(`Invalid Asura home cursor: ${cursor}`);
        const limit = 50;
        const query = new URLSearchParams({
            sort: 'latest',
            order: 'desc',
            limit: String(limit),
            offset: String((page - 1) * limit),
        });
        const res = await fetch(`${API_BASE}/series?${query}`);
        if (!res.ok) throw new Error(`Series catalog failed: ${res.status}`);
        const response = await res.json() as {
            data: AsuraHomeSeries[];
            meta: { total: number; has_more: boolean };
        };
        const now = Date.now();
        return {
            total: response.meta.total,
            nextCursor: response.meta.has_more ? String(page + 1) : null,
            series: response.data.map(series => ({
                slug: publicSlug(series.public_url),
                historyId: series.slug,
                title: series.title,
                coverUrl: coverUrl(series.cover),
                chapters: series.latest_chapters.slice(0, 3).map(chapter => {
                    const unlockTime = chapter.early_access_until === null
                        ? null
                        : new Date(chapter.early_access_until).getTime();
                    const locked = chapter.is_premium && (unlockTime === null || unlockTime > now);
                    return {
                        chapterId: String(chapter.number),
                        label: `Chapter ${chapter.number}`,
                        uploadedAt: chapter.published_at,
                        locked,
                        unlockAt: locked ? chapter.early_access_until : null,
                    };
                }),
            })),
        };
    },

    async fetchRemoteHistory(): Promise<RemoteSeriesHistory[]> {
        if (!asuraTokenManager.hasSession()) return [];
        const response = await asuraTokenManager.fetch(`${API_BASE}/me/read-chapters`);
        if (!response.ok) throw new Error(`Asura read history failed: ${response.status}`);
        return parseAsuraRemoteHistory(await response.json());
    },

    async fetchChapter(slug: string, chapterId: string): Promise<ChapterData | null> {
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
            seriesTitle: data.series.title,
            seriesApiId: data.series.id,
            chapterApiId: data.chapter.id,
            images,
        };
    },

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

    async trackChapter(data: ChapterData): Promise<void> {
        if (!data.seriesApiId || !data.chapterApiId || !asuraTokenManager.hasSession()) return;
        const headers = { 'Content-Type': 'application/json' };
        const responses = await Promise.all([
            asuraTokenManager.fetch(`${API_BASE}/bookmarks/${data.seriesApiId}/read/${data.chapterId}`, {
                method: 'POST',
                headers,
            }),
            asuraTokenManager.fetch(`${API_BASE}/views/chapter`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ chapter_id: data.chapterApiId, series_id: data.seriesApiId }),
            }),
        ]);
        for (const response of responses) {
            if (!response.ok) throw new Error(`Asura chapter tracking failed: ${response.status}`);
        }
    },
};
