import type { Provider, RouteMatch, ChapterMeta } from './types';
import { Handler } from './types';
import { SITE_CONFIG } from '../sites';

export function createAngularProvider(site: keyof typeof SITE_CONFIG): Provider {
    const { domain, apiBase } = SITE_CONFIG[site];
    const CHAPTER_RE = /\/([^/]+)\/([^/]+)\/([^/]+)$/;

    return {
        matchRoute(pathname: string): RouteMatch | null {
            const m = CHAPTER_RE.exec(pathname);
            if (!m) return null;
            return { handler: Handler.Reader, slug: m[2], chapter: m[3] };
        },

        async init(): Promise<void> { /* no-op */ },

        async fetchChapter(slug: string, chapterId: string): Promise<import('./types').ChapterData> {
            const res = await fetch(`${apiBase}/series/${slug}/chapters/${chapterId}`);
            if (!res.ok) throw new Error(`Chapter not found: ${res.status}`);
            const data = await res.json() as Record<string, unknown>;
            if (!data.isFree || data.requiresPurchase) throw new Error('Chapter is paid');
            const nav = (data as { navigation?: { prev?: { slug?: string } | null; next?: { slug?: string } | null } }).navigation;

            return {
                ...(data as unknown as import('./types').ChapterData),
                prevUrl: nav?.prev?.slug ? `https://${domain}/series/${slug}/${nav.prev.slug}` : null,
                nextUrl: nav?.next?.slug ? `https://${domain}/series/${slug}/${nav.next.slug}` : null,
            };
        },

        async fetchChapterList(slug: string): Promise<ChapterMeta[]> {
            const chapters: ChapterMeta[] = [];
            let page = 1;
            let hasMore = true;
            while (hasMore) {
                const res = await fetch(`${apiBase}/series/${slug}/chapters?perPage=100&page=${page}`);
                if (!res.ok) throw new Error(`Chapter list failed: ${res.status}`);
                const data = await res.json() as { data?: Array<{ slug: string }>; totalPages?: number; next?: number | null };
                for (const item of data.data ?? []) {
                    chapters.push({ slug: item.slug });
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

        getNextChapter(chapterList: ChapterMeta[], lastChapter: string): ChapterMeta {
            const idx = chapterList.findIndex(m => m.slug === lastChapter);
            return chapterList[idx - 1];
        },
    };
}
