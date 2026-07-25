import type { Provider, RouteMatch, ChapterData, ChapterMeta, ChapterImage } from './types';
import { SITE_CONFIG } from '../core/sites';
import { isChapterUnavailable } from '../core/http';

// URL: /<slug>-chapter-<number>/
const CHAPTER_RE = /^\/(.+)-chapter-(\d+(?:\.\d+)?)\/?$/;
const DOMAIN = SITE_CONFIG['scythescans'].domain;

interface TsReaderData {
    sources?: Array<{ images?: string[] }>;
}

export const scythe: Provider = {

    matchRoute(pathname: string): RouteMatch | null {
        const m = CHAPTER_RE.exec(pathname);
        if (!m) return null;
        const chapterSlug = `${m[1]}-chapter-${m[2]}`;
        return { slug: m[1], chapterId: chapterSlug };
    },


    async fetchChapter(_slug: string, chapterId: string): Promise<ChapterData | null> {
        const url = `https://${DOMAIN}/${chapterId}/`;
        const res = await fetch(url);
        if (isChapterUnavailable(res)) return null;
        const html = await res.text();

        // Extract base64-encoded ts_reader.run({...}) JSON
        let tsData: TsReaderData = {};
        const b64Match = html.match(/<script defer src="data:text\/javascript;base64,([A-Za-z0-9+/=]+)"><\/script>/g);
        if (b64Match) {
            for (const tag of b64Match) {
                const b64 = tag.match(/base64,([A-Za-z0-9+/=]+)/);
                if (!b64) continue;
                const decoded = atob(b64[1]);
                if (decoded.includes('ts_reader.run(')) {
                    const jsonMatch = /^ts_reader\.run\((\{[\s\S]*\})\);?$/u.exec(decoded.trim());
                    if (jsonMatch) {
                        tsData = JSON.parse(jsonMatch[1]) as TsReaderData;
                    }
                    break;
                }
            }
        }

        const srcs: string[] = tsData.sources?.[0]?.images ?? [];
        if (srcs.length === 0) throw new Error('Chapter response contained no images');

        const images: ChapterImage[] = srcs.map(url => ({ url }));

        // Series title from .allc div
        const seriesMatch = /<div class="allc">All chapters are in <a[^>]*>([^<]+)<\/a><\/div>/.exec(html);
        const seriesTitle = seriesMatch ? seriesMatch[1].trim() : '';

        return {
            chapterId: chapterId,
            seriesTitle: seriesTitle,
            images,
        };
    },

    async fetchChaptersNewestFirst(slug: string): Promise<ChapterMeta[]> {
        const url = `https://${DOMAIN}/manga/${slug}/`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Manga page not found: ${res.status}`);
        const html = await res.text();

        const chapters: ChapterMeta[] = [];
        // Match chapter links in #chapterlist
        const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const chapterSlugRe = new RegExp(`https://${DOMAIN.replace(/\./g, '\\.')}/(${escapedSlug}-chapter-[\\d.]+)/`, 'g');
        for (const m of html.matchAll(chapterSlugRe)) {
            chapters.push({ chapterId: m[1] });
        }
        return chapters;
    },

    readerUrl(_slug: string, chapterId: string, imageIndex?: string): string {
        return `https://${DOMAIN}/${chapterId}/${imageIndex ? `#${imageIndex}` : ''}`;
    },

    seriesUrl(slug: string): string {
        return `https://${DOMAIN}/manga/${slug}/`;
    },
};
