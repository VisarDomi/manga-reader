import type { Provider, RouteMatch, ChapterData, ChapterMeta, ChapterImage } from './types';
import { Handler } from './types';

const CHAPTER_RE = /^\/manga\/([^/]+)\/chapter-([\d.]+)/;
const DOMAIN = 'yakshacomics.com';

export const yaksha: Provider = {
    name: 'yaksha',

    matchRoute(pathname: string): RouteMatch | null {
        const m = CHAPTER_RE.exec(pathname);
        if (!m) return null;
        return { handler: Handler.Reader, slug: m[1], chapter: m[2] };
    },

    async init(): Promise<void> {
        // no-op
    },

    async fetchChapter(slug: string, chapter: string): Promise<ChapterData> {
        const url = chapterUrl(slug, chapter);
        const res = await fetch(url);
        if (res.redirected || !res.ok) throw new Error('Chapter not found');
        const html = await res.text();

        // Scrape image URLs (attribute order varies: src may appear before or after class)
        const srcs: string[] = [];
        const imgTagRe = /<img\b[^>]*\bclass="wp-manga-chapter-img"[^>]*>/g;
        let tagMatch;
        while ((tagMatch = imgTagRe.exec(html)) !== null) {
            const srcMatch = /src="([^"]+)"/.exec(tagMatch[0]);
            if (srcMatch) srcs.push(srcMatch[1].trim().replace(/\s+/g, ''));
        }

        if (srcs.length === 0) throw new Error('Chapter not found');

        const images: ChapterImage[] = srcs.map((src, i) => {
            return { url: src, order: i, width: 0, height: 0 };
        });

        // Series title from breadcrumbs (scoped to breadcrumb block)
        const bcMatch = /<ol class="breadcrumb">[\s\S]*?<a[^>]*href="[^"]*\/manga\/[^/]+\/"[^>]*>([^<]+)<\/a>/.exec(html);
        const seriesTitle = bcMatch ? bcMatch[1].trim() : '';

        // Scrape actual prev/next links from the chapter page.
        const prevHref = /<a[^>]*href="([^"]+)"[^>]*class="[^"]*prev_page/.exec(html);
        const nextHref = /<a[^>]*href="([^"]+)"[^>]*class="[^"]*next_page/.exec(html);
        const prev = prevHref?.[1] ?? null;
        const next = nextHref?.[1] ?? null;

        return {
            slug,
            number: parseFloat(chapter),
            title: null,
            content: null,
            cover: '',
            publishStatus: 'PUBLIC',
            price: 0,
            isFree: true,
            requiresPurchase: false,
            series: { title: seriesTitle },
            images,
            prevUrl: prev,
            nextUrl: next,
        };
    },

    async fetchChapterList(slug: string): Promise<ChapterMeta[]> {
        const url = `https://${DOMAIN}/manga/${slug}/`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Manga page not found: ${res.status}`);
        const html = await res.text();

        // Scrape chapters from the listing block
        const chapters: ChapterMeta[] = [];
        const liRe = /<li class="wp-manga-chapter[^"]*">[\s\S]*?<a href="([^"]+)">Chapter\s+([\d.]+)<\/a>/g;
        let m;
        while ((m = liRe.exec(html)) !== null) {
            chapters.push({ slug: `chapter-${m[2]}` });
        }
        return chapters;
    },

    seriesUrl(slug: string): string {
        return `https://${DOMAIN}/manga/${slug}/`;
    },
};

function chapterUrl(slug: string, chapter: string): string {
    return `https://${DOMAIN}/manga/${slug}/chapter-${chapter}/`;
}
