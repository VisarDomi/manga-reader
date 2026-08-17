import {
    Handler,
    type Provider,
    type RouteMatch,
    type ChapterMeta,
    type HomePage,
} from './types';
import { SITE_CONFIG } from '../core/sites';
import { isChapterUnavailable } from '../core/http';
import { hashImageIndex } from '../core/page';
import { fetchAngularHome } from './angular-catalog';
import { lastImageIndexFrom, percentImageIndexFrom } from './resume';

export function createAngularProvider(site: keyof typeof SITE_CONFIG): Provider {
    const { domain, apiBase, documentTitle } = SITE_CONFIG[site];
    const CHAPTER_RE = /\/([^/]+)\/([^/]+)\/([^/]+)$/;

    async function fetchAngularChapter(slug: string, chapterId: string): Promise<import('./types').ChapterData | null> {
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
        seriesSlug: slug,
        seriesTitle: data.series.title,
        images: data.images.map(({ url, width, height }) => ({ url, width, height })),
    };
    }


    return {
        key: site,
        catalogInWorker: true,
        documentTitle,

        matchRoute(pathname: string, hash: string): RouteMatch | null {
            if (pathname === '/') return { handler: Handler.Home };
            const m = CHAPTER_RE.exec(pathname);
            if (!m) return null;
            return { handler: Handler.Reader, slug: m[2], chapterId: m[3], imageIndex: hashImageIndex(hash) };
        },

        async fetchHome(cursor: string | null): Promise<HomePage> {
            return fetchAngularHome(site, cursor);
        },

        async fetchChapter(slug: string, chapterId: string): Promise<import('./types').ChapterData | null> {
            return fetchAngularChapter(slug, chapterId);
        },

        lastReadImageIndex: lastImageIndexFrom(fetchAngularChapter),
        resumeImageIndex: percentImageIndexFrom(fetchAngularChapter),

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