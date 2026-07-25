import type { Provider, RouteMatch, ChapterData, ChapterMeta, ChapterImage } from './types';
import { Handler } from './types';
import { SITE_CONFIG } from '../sites';

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
        return { handler: Handler.Reader, slug: m[1], chapter: chapterSlug };
    },

    async init(): Promise<void> { /* no-op */ },

    async fetchChapter(_slug: string, chapterId: string): Promise<ChapterData> {
        const url = `https://${DOMAIN}/${chapterId}/`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('Chapter not found');
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
                    const jsonMatch = decoded.match(/ts_reader\.run\((\{[\s\S]*\\})\);?$/);
                    if (jsonMatch) {
                        try {
                            tsData = JSON.parse(jsonMatch[1]) as TsReaderData;
                        } catch { /* ignore parse errors */ }
                    }
                    break;
                }
            }
        }

        const srcs: string[] = tsData.sources?.[0]?.images ?? [];
        if (srcs.length === 0) throw new Error('No chapter images found');

        const images: ChapterImage[] = srcs.map((src, i) => ({
            url: src,
            order: i,
            width: 0,
            height: 0,
        }));

        // Series title from .allc div
        const seriesMatch = /<div class="allc">All chapters are in <a[^>]*>([^<]+)<\/a><\/div>/.exec(html);
        const seriesTitle = seriesMatch ? seriesMatch[1].trim() : '';

        return {
            chapterId: chapterId,
            seriesTitle: seriesTitle,
            images,
        };
    },

    async fetchChapterList(slug: string): Promise<ChapterMeta[]> {
        const url = `https://${DOMAIN}/manga/${slug}/`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Manga page not found: ${res.status}`);
        const html = await res.text();

        const chapters: ChapterMeta[] = [];
        // Match chapter links in #chapterlist
        const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const chapterSlugRe = new RegExp(`https://${DOMAIN.replace(/\./g, '\\.')}/(${escapedSlug}-chapter-[\\d.]+)/`, 'g');
        let m;
        while ((m = chapterSlugRe.exec(html)) !== null) {
            chapters.push({ slug: m[1] });
        }
        return chapters;
    },

    readerUrl(_slug: string, chapterId: string, imgIdx?: string): string {
        return `https://${DOMAIN}/${chapterId}/${imgIdx ? `#${imgIdx}` : ''}`;
    },

    seriesUrl(slug: string): string {
        return `https://${DOMAIN}/manga/${slug}/`;
    },

    getNextChapter(chapterList: ChapterMeta[], lastChapter: string): ChapterMeta {
        const idx = chapterList.findIndex(m => m.slug === lastChapter);
        return chapterList[idx - 1];
    },
};
