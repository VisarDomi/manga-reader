import {
    Handler,
    type Provider,
    type RouteMatch,
    type ChapterMeta,
    type HomeChapter,
    type HomePage,
    type HomeSeries,
} from './types';
import { SITE_CONFIG } from '../core/sites';
import { isChapterUnavailable } from '../core/http';
import { hashImageIndex } from '../core/page';

export function createAngularProvider(site: keyof typeof SITE_CONFIG): Provider {
    const { domain, apiBase, documentTitle } = SITE_CONFIG[site];
    const CHAPTER_RE = /\/([^/]+)\/([^/]+)\/([^/]+)$/;

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
            throw new Error(`Invalid ${site} home cursor: ${cursor}`);
        }
        return { source: match[1] as 'latest' | 'catalog', page };
    }

    return {
        key: site,
        documentTitle,

        matchRoute(pathname: string, hash: string): RouteMatch | null {
            if (pathname === '/') return { handler: Handler.Home };
            const m = CHAPTER_RE.exec(pathname);
            if (!m) return null;
            return { handler: Handler.Reader, slug: m[2], chapterId: m[3], imageIndex: hashImageIndex(hash) };
        },

        async fetchHome(cursor: string | null): Promise<HomePage> {
            const { source, page } = homeCursor(cursor);
            if (source === 'latest') {
                const res = await fetch(`${apiBase}/home/latest?page=${page}&perPage=50`);
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

            const res = await fetch(`${apiBase}/series?perPage=100&page=${page}`);
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
                nextCursor: hasMore ? `catalog:${page + 1}` : null,
                total: data.totalItems,
            };
        },

        async fetchChapter(slug: string, chapterId: string): Promise<import('./types').ChapterData | null> {
            const res = await fetch(`${apiBase}/series/${slug}/chapters/${chapterId}`);
            if (isChapterUnavailable(res)) return null;
            const data = await res.json() as {
                isFree: boolean;
                requiresPurchase: boolean;
                images: Array<{ url: string; width?: number; height?: number }>;
                series: { title: string };
            };
            if (!data.isFree || data.requiresPurchase) return null;

            return {
                chapterId,
                seriesTitle: data.series.title,
                images: data.images.map(({ url, width, height }) => ({ url, width, height })),
            };
        },

        async fetchChaptersNewestFirst(slug: string): Promise<ChapterMeta[]> {
            const chapters: ChapterMeta[] = [];
            let page = 1;
            let hasMore = true;
            while (hasMore) {
                const res = await fetch(`${apiBase}/series/${slug}/chapters?perPage=100&page=${page}`);
                if (!res.ok) throw new Error(`Chapter list failed: ${res.status}`);
                const data = await res.json() as { data: Array<{ slug: string }>; totalPages: number; next?: number | null };
                for (const item of data.data) {
                    chapters.push({ chapterId: item.slug });
                }
                hasMore = data.next != null || page < data.totalPages;
                page++;
            }
            return chapters;
        },

        readerUrl(_slug: string, chapterId: string, imageIndex?: string): string {
            return `https://${domain}/series/${_slug}/${chapterId}${imageIndex ? `#${imageIndex}` : ''}`;
        },

        seriesUrl(slug: string): string {
            return `https://${domain}/series/${slug}`;
        },
    };
}
