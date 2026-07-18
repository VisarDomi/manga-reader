import type { Provider, RouteMatch, ChapterData, ChapterMeta, ChapterImage } from './types';
import { Handler } from './types';

const CHAPTER_RE = /\/(.+)-chapter-([^/]+)\/?$/;
const DOMAIN = 'violetscans.org';

export const violet: Provider = {
    name: 'violet',

    matchRoute(pathname: string): RouteMatch | null {
        const m = CHAPTER_RE.exec(pathname);
        if (!m) return null;
        return { handler: Handler.Reader, slug: m[1], chapter: m[2] };
    },

    async init(): Promise<void> { /* no-op */ },

    async fetchChapter(slug: string, chapterId: string): Promise<ChapterData> {
        const url = `https://${DOMAIN}/${slug}-chapter-${chapterId}/`;
        const res = await fetch(url);
        if (res.redirected || !res.ok) throw new Error('Chapter not found');
        const html = await res.text();

        // Extract ts_reader.run({...}) JSON payload
        const tsMatch = /ts_reader\.run\((\{[\s\S]*?\})\);?/.exec(html);
        if (!tsMatch) throw new Error('Chapter not found');

        const raw = tsMatch[1];
        const data = JSON.parse(raw);

        const srcs: string[] = data.sources?.[0]?.images ?? [];
        if (srcs.length === 0) throw new Error('Chapter not found');

        const images: ChapterImage[] = srcs.map((src: string, i: number) => ({
            url: src,
            order: i,
            width: 0,
            height: 0,
        }));

        // Extract series title from HISTORY.push or breadcrumb
        let seriesTitle = '';
        const histMatch = /HISTORY\.push\(\d+,\s*(\{[\s\S]*?\})\);?/.exec(html);
        if (histMatch) {
            try {
                const hist = JSON.parse(histMatch[1]);
                seriesTitle = hist.manga_title || '';
            } catch { /* ignore */ }
        }
        if (!seriesTitle) {
            const bcRe = new RegExp(
                `<a[^>]*href="[^"]*\\/comics\\/${escapeRe(slug)}\\/"[^>]*><span[^>]*itemprop="name"[^>]*>([^<]+)<\\/span><\\/a>`,
                'i',
            );
            const bcMatch = bcRe.exec(html);
            seriesTitle = bcMatch ? bcMatch[1].trim() : '';
        }

        return {
            slug,
            number: 0,
            title: null,
            content: null,
            cover: '',
            publishStatus: 'PUBLIC',
            price: 0,
            isFree: true,
            requiresPurchase: false,
            series: { title: seriesTitle },
            images,
            prevUrl: data.prevUrl || null,
            nextUrl: data.nextUrl || null,
        };
    },

    async fetchChapterList(slug: string): Promise<ChapterMeta[]> {
        const url = `https://${DOMAIN}/comics/${slug}/`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Series page not found: ${res.status}`);
        const html = await res.text();

        const chapters: ChapterMeta[] = [];
        const liRe = /<li\b[^>]*data-num="[^"]*"[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>/g;
        let m;
        while ((m = liRe.exec(html)) !== null) {
            const href = m[1];
            const cm = CHAPTER_RE.exec(href);
            if (cm) {
                chapters.push({ slug: cm[2] });
            }
        }
        return chapters;
    },

    readerUrl(slug: string, chapterId: string, imgIdx?: string): string {
        return `https://${DOMAIN}/${slug}-chapter-${chapterId}/${imgIdx ? `#${imgIdx}` : ''}`;
    },

    seriesUrl(slug: string): string {
        return `https://${DOMAIN}/comics/${slug}/`;
    },

    getNextChapter(chapterList: ChapterMeta[], lastChapter: string): ChapterMeta {
        const idx = chapterList.findIndex(m => m.slug === lastChapter);
        return chapterList[idx - 1];
    },
};

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
