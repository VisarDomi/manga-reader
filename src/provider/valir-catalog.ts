// Worker-safe catalog fetch for valirscans. No DOM, no token manager.
import { SITE_CONFIG } from '../core/sites';
import type { HomePage } from './types';

const DOMAIN = SITE_CONFIG['valirscans'].domain;

export async function fetchValirHome(cursor: string | null, referrer?: string): Promise<HomePage> {
    const page = cursor === null ? 1 : Number(cursor);
    if (!Number.isSafeInteger(page) || page < 1) throw new Error(`Invalid Valir home cursor: ${cursor}`);
    const limit = 100;
    const query = new URLSearchParams({
        type: 'MANHWA,MANHUA,MANGA,WEBTOON',
        page: String(page),
        limit: String(limit),
    });
    const res = await fetch(`https://${DOMAIN}/api/series?${query}`, referrer ? { referrer } : undefined);
    if (!res.ok) throw new Error(`Series catalog failed: ${res.status}`);
    const response = await res.json() as {
        data: Array<{
            slug: string;
            urlSlug: string;
            title: string;
            coverImage: string;
            chapters: Array<{
                number: number;
                title: string;
                isLocked: boolean;
                isFree: boolean;
                coinPrice: number;
                publishedAt: string;
                unlockedAt: string | null;
            }>;
        }>;
        meta: { total: number; hasMore: boolean };
    };
    return {
        total: response.meta.total,
        nextCursor: response.meta.hasMore ? String(page + 1) : null,
        series: response.data.map(series => ({
            slug: series.urlSlug || series.slug,
            title: series.title,
            coverUrl: new URL(series.coverImage, `https://${DOMAIN}`).href,
            chapters: series.chapters.slice(0, 5).map(chapter => ({
                chapterId: String(chapter.number),
                label: chapter.title || `Chapter ${chapter.number}`,
                uploadedAt: chapter.publishedAt,
                locked: chapter.isLocked || !chapter.isFree || chapter.coinPrice > 0,
                unlockAt: chapter.unlockedAt,
            })),
        })),
    };
}
