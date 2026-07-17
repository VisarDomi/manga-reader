import type { Provider, RouteMatch, ChapterData, ChapterMeta } from './types';
import { Handler } from './types';

export interface AngularConfig {
    name: string;
    apiBase: string;
    siteDomain: string;
}

export function createAngularProvider({ name, apiBase, siteDomain }: AngularConfig): Provider {
    const CHAPTER_RE = /\/([^/]+)\/([^/]+)$/;

    return {
        name,

        matchRoute(pathname: string): RouteMatch | null {
            const m = CHAPTER_RE.exec(pathname);
            if (!m) return null;
            return { handler: Handler.Reader, slug: m[1], chapter: m[2] };
        },

        async init(): Promise<void> { /* no-op */ },

        async fetchChapter(slug: string, chapterId: string): Promise<ChapterData> {
            const res = await fetch(`${apiBase}/series/${slug}/chapters/${chapterId}`);
            if (!res.ok) throw new Error(`Chapter not found: ${res.status}`);
            const data = await res.json() as Record<string, unknown>;
            if (!data.isFree || data.requiresPurchase) throw new Error('Chapter is paid');
            const nav = (data as { navigation?: { prev?: { slug?: string } | null; next?: { slug?: string } | null } }).navigation;

            return {
                ...(data as unknown as ChapterData),
                prevUrl: nav?.prev?.slug ? `https://${siteDomain}/series/${slug}/${nav.prev.slug}` : null,
                nextUrl: nav?.next?.slug ? `https://${siteDomain}/series/${slug}/${nav.next.slug}` : null,
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
            return `https://${siteDomain}/series/${_slug}/${chapterId}${imgIdx ? `#${imgIdx}` : ''}`;
        },

        seriesUrl(slug: string): string {
            return `https://${siteDomain}/series/${slug}`;
        },
    };
}
