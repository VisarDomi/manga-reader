// Worker-safe catalog fetch for asurascans. No DOM, no token manager.
import { SITE_CONFIG } from '../core/sites';
import type { HomePage } from './types';
import { asuraHistoryId } from './asura';

const DOMAIN = SITE_CONFIG.asurascans.domain;
const API_BASE = SITE_CONFIG.asurascans.apiBase!;

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

function publicSlug(publicUrl: string): string {
    const match = /^\/comics\/([^/]+)$/.exec(new URL(publicUrl, `https://${DOMAIN}`).pathname);
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

export async function fetchAsuraHome(cursor: string | null, referrer?: string): Promise<HomePage> {
    const page = cursor === null ? 1 : Number(cursor);
    if (!Number.isSafeInteger(page) || page < 1) throw new Error(`Invalid Asura home cursor: ${cursor}`);
    const limit = 50;
    const query = new URLSearchParams({
        sort: 'latest',
        order: 'desc',
        limit: String(limit),
        offset: String((page - 1) * limit),
    });
    const res = await fetch(`${API_BASE}/series?${query}`, referrer ? { referrer } : undefined);
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
            historyId: asuraHistoryId(series.slug),
            title: series.title,
            coverUrl: coverUrl(series.cover),
            chapters: series.latest_chapters.slice(0, 5).map(chapter => {
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
}
