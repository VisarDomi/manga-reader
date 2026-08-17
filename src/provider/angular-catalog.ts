// Worker-safe catalog fetch for the Angular providers (ezmanga, qimanga).
import type { Site } from '../core/sites';
import { SITE_CONFIG } from '../core/sites';
import type { HomeChapter, HomePage, HomeSeries } from './types';

interface AngularHomeChapter {
    slug: string;
    number: number;
    price: number;
    becameFreeAt: string | null;
    createdAt: string;
}

interface AngularHomeSeries {
    slug: string;
    title: string;
    cover: string;
    chapters?: AngularHomeChapter[];
}

function homeChapter(chapter: AngularHomeChapter): HomeChapter {
    const freeAt = chapter.becameFreeAt === null ? null : new Date(chapter.becameFreeAt).getTime();
    const locked = chapter.price > 0 && (freeAt === null || freeAt > Date.now());
    return {
        chapterId: chapter.slug,
        label: `Chapter ${chapter.number}`,
        uploadedAt: locked ? chapter.createdAt : chapter.becameFreeAt ?? chapter.createdAt,
        locked,
        unlockAt: locked && freeAt !== null ? chapter.becameFreeAt : null,
    };
}

function homeSeries(series: AngularHomeSeries): HomeSeries {
    return {
        slug: series.slug,
        title: series.title.trim(),
        coverUrl: series.cover,
        chapters: (series.chapters ?? []).slice(0, 5).map(homeChapter),
    };
}

function homeCursor(cursor: string | null): { source: 'latest' | 'catalog'; page: number } {
    if (cursor === null) return { source: 'latest', page: 1 };
    const match = /^(latest|catalog):(\d+)$/.exec(cursor);
    const page = Number(match?.[2]);
    if (!match || !Number.isSafeInteger(page) || page < 1) {
        throw new Error(`Invalid home cursor: ${cursor}`);
    }
    return { source: match[1] as 'latest' | 'catalog', page };
}

export async function fetchAngularHome(site: Site, cursor: string | null, referrer?: string): Promise<HomePage> {
    const { apiBase } = SITE_CONFIG[site];
    const { source, page } = homeCursor(cursor);
    if (source === 'latest') {
        const res = await fetch(`${apiBase}/home/latest?page=${page}&perPage=50`, referrer ? { referrer } : undefined);
        if (!res.ok) throw new Error(`Latest series failed: ${res.status}`);
        const data = await res.json() as {
            data: AngularHomeSeries[];
            totalItems: number;
            totalPages: number;
            next?: number | null;
        };
        const hasMore = data.next != null || page < data.totalPages;
        return {
            series: data.data.map(homeSeries),
            total: data.totalItems,
            nextCursor: hasMore ? `latest:${page + 1}` : 'catalog:1',
        };
    }

    const res = await fetch(`${apiBase}/series?perPage=100&page=${page}`, referrer ? { referrer } : undefined);
    if (!res.ok) throw new Error(`Series catalog failed: ${res.status}`);
    const data = await res.json() as {
        data: AngularHomeSeries[];
        totalItems: number;
        totalPages: number;
        next?: number | null;
    };
    const hasMore = data.next != null || page < data.totalPages;
    return {
        series: data.data.map(homeSeries),
        total: data.totalItems,
        nextCursor: hasMore ? `catalog:${page + 1}` : null,
    };
}
