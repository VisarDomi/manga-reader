import type { Provider, RouteMatch, ChapterData, ChapterMeta, ChapterImage } from './types';
import { SITE_CONFIG } from '../core/sites';
import { isChapterUnavailable } from '../core/http';
import { hashImageIndex } from '../core/page';

const CHAPTER_RE = /^\/manga\/([^/]+)\/([^/]+)\/?$/;
const DOMAIN = SITE_CONFIG['yakshacomics'].domain;

export const yaksha: Provider = {

    matchRoute(pathname: string, hash: string): RouteMatch | null {
        const m = CHAPTER_RE.exec(pathname);
        if (!m) return null;
        return { slug: m[1], chapterId: m[2], imageIndex: hashImageIndex(hash) };
    },


    async fetchChapter(slug: string, chapterId: string): Promise<ChapterData | null> {
        const url = `https://${DOMAIN}/manga/${slug}/${chapterId}/`;
        const res = await fetch(url);
        if (isChapterUnavailable(res)) return null;
        const html = await res.text();

        const srcs: string[] = [];
        const imgTagRe = /<img\b[^>]*\bclass="wp-manga-chapter-img"[^>]*>/g;
        for (const tagMatch of html.matchAll(imgTagRe)) {
            const srcMatch = /src="([^"]+)"/.exec(tagMatch[0]);
            if (srcMatch) srcs.push(srcMatch[1].trim().replace(/\s+/g, ''));
        }

        if (srcs.length === 0) throw new Error('Chapter response contained no images');

        const images: ChapterImage[] = srcs.map(url => ({ url }));

        const bcMatch = /<ol class="breadcrumb">[\s\S]*?<a[^>]*href="[^"]*\/manga\/[^/]+\/"[^>]*>([^<]+)<\/a>/.exec(html);
        const seriesTitle = bcMatch ? bcMatch[1].trim() : '';

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
        const liRe = /<li class="wp-manga-chapter[^"]*">[\s\S]*?<a href="([^"]+)">[\s\S]*?Chapter\s+([\d.]+)\s*<\/a>/g;
        for (const m of html.matchAll(liRe)) {
            chapters.push({ chapterId: `chapter-${m[2]}` });
        }
        return chapters;
    },

    readerUrl(_slug: string, chapterId: string, imageIndex?: string): string {
        return `https://${DOMAIN}/manga/${_slug}/${chapterId}/${imageIndex ? `#${imageIndex}` : ''}`;
    },

    seriesUrl(slug: string): string {
        return `https://${DOMAIN}/manga/${slug}/`;
    },
};
