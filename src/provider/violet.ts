import type { Provider, RouteMatch, ChapterData, ChapterMeta, ChapterImage } from './types';
import { Handler } from './types';
import { SITE_CONFIG } from '../core/sites';
import { isChapterUnavailable } from '../core/http';

const CHAPTER_RE = /\/(.+)-chapter-([^/]+)\/?$/;
const DOMAIN = SITE_CONFIG['violetscans'].domain;

export const violet: Provider = {

    matchRoute(pathname: string): RouteMatch | null {
        const m = CHAPTER_RE.exec(pathname);
        if (!m) return null;
        return { handler: Handler.Reader, slug: m[1], chapter: m[2] };
    },


    async fetchChapter(slug: string, chapterId: string): Promise<ChapterData | null> {
        const url = `https://${DOMAIN}/${slug}-chapter-${chapterId}/`;
        const res = await fetch(url);
        if (isChapterUnavailable(res)) return null;
        const html = await res.text();

        // Extract ts_reader.run({...}) JSON payload
        const tsMatch = /ts_reader\.run\((\{[\s\S]*?\\})\);?/.exec(html);
        if (!tsMatch) throw new Error('Chapter response did not contain reader data');

        const raw = tsMatch[1];
        const data = JSON.parse(raw);

        const srcs: string[] = data.sources?.[0]?.images ?? [];
        if (srcs.length === 0) throw new Error('Chapter response contained no images');

        const images: ChapterImage[] = srcs.map((src: string) => ({
            url: src,
            width: 0,
            height: 0,
        }));

        // Extract series title from HISTORY.push or breadcrumb
        let seriesTitle = '';
        const histMatch = /HISTORY\.push\(\d+,\s*(\{[\s\S]*?\\})\);?/.exec(html);
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
            chapterId: chapterId,
            seriesTitle: seriesTitle,
            images,
        };
    },

    async fetchChaptersNewestFirst(slug: string): Promise<ChapterMeta[]> {
        const url = `https://${DOMAIN}/comics/${slug}/`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Series page not found: ${res.status}`);
        const html = await res.text();

        const chapters: ChapterMeta[] = [];
        const liRe = /<li\b[^>]*data-num="[^"]*"[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>/g;
        for (const m of html.matchAll(liRe)) {
            const href = m[1];
            const cm = CHAPTER_RE.exec(href);
            if (cm) {
                chapters.push({ chapterId: cm[2] });
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
};

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
