import type { Provider, RouteMatch, ChapterMeta } from './types';
import { Handler } from './types';
import { SITE_CONFIG } from '../core/sites';
import { isChapterUnavailable } from '../core/http';

export function createAngularProvider(site: keyof typeof SITE_CONFIG): Provider {
    const { domain, apiBase } = SITE_CONFIG[site];
    const CHAPTER_RE = /\/([^/]+)\/([^/]+)\/([^/]+)$/;

    return {
        matchRoute(pathname: string): RouteMatch | null {
            const m = CHAPTER_RE.exec(pathname);
            if (!m) return null;
            return { handler: Handler.Reader, slug: m[2], chapter: m[3] };
        },


        async fetchChapter(slug: string, chapterId: string): Promise<import('./types').ChapterData | null> {
            const res = await fetch(`${apiBase}/series/${slug}/chapters/${chapterId}`);
            if (isChapterUnavailable(res)) return null;
            const data = await res.json() as Record<string, unknown>;
            if (!data.isFree || data.requiresPurchase) return null;

            return {
                ...(data as unknown as import('./types').ChapterData),
            };
        },

        async fetchChaptersNewestFirst(slug: string): Promise<ChapterMeta[]> {
            const chapters: ChapterMeta[] = [];
            let page = 1;
            let hasMore = true;
            while (hasMore) {
                const res = await fetch(`${apiBase}/series/${slug}/chapters?perPage=100&page=${page}`);
                if (!res.ok) throw new Error(`Chapter list failed: ${res.status}`);
                const data = await res.json() as { data: Array<{ slug: string }>; totalPages?: number; next?: number | null };
                for (const item of data.data) {
                    chapters.push({ chapterId: item.slug });
                }
                hasMore = data.next != null;
                page++;
            }
            return chapters;
        },

        readerUrl(_slug: string, chapterId: string, imgIdx?: string): string {
            return `https://${domain}/series/${_slug}/${chapterId}${imgIdx ? `#${imgIdx}` : ''}`;
        },

        seriesUrl(slug: string): string {
            return `https://${domain}/series/${slug}`;
        },
    };
}
