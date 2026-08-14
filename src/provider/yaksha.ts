import {
    Handler,
    type Provider,
    type RouteMatch,
    type ChapterData,
    type ChapterMeta,
    type ChapterImage,
    type HomePage,
} from './types';
import { SITE_CONFIG } from '../core/sites';
import { isChapterUnavailable } from '../core/http';
import { hashImageIndex } from '../core/page';

const CHAPTER_RE = /^\/manga\/([^/]+)\/([^/]+)\/?$/;
const DOMAIN = SITE_CONFIG['yakshacomics'].domain;

export const yaksha: Provider = {
    key: 'yakshacomics',
    documentTitle: SITE_CONFIG.yakshacomics.documentTitle,

    matchRoute(pathname: string, hash: string): RouteMatch | null {
        if (pathname === '/') return { handler: Handler.Home };
        const m = CHAPTER_RE.exec(pathname);
        if (!m) return null;
        return { handler: Handler.Reader, slug: m[1], chapterId: m[2], imageIndex: hashImageIndex(hash) };
    },

    async fetchHome(cursor: string | null): Promise<HomePage> {
        const page = cursor === null ? 1 : Number(cursor);
        if (!Number.isSafeInteger(page) || page < 1) throw new Error(`Invalid Yaksha home cursor: ${cursor}`);
        const url = page === 1 ? `https://${DOMAIN}/` : `https://${DOMAIN}/page/${page}/`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Series catalog failed: ${res.status}`);
        const document = new DOMParser().parseFromString(await res.text(), 'text/html');
        const series = [...document.querySelectorAll('.page-listing-item .page-item-detail')].map(card => {
            const link = card.querySelector<HTMLAnchorElement>('.post-title a');
            const cover = card.querySelector<HTMLImageElement>('.item-thumb img');
            const title = link?.textContent?.replace(/\s+/g, ' ').trim();
            const href = link?.getAttribute('href');
            if (!href || !cover || !title) throw new Error('Yaksha catalog card is incomplete');
            const match = /^\/manga\/([^/]+)\/?$/.exec(new URL(href, `https://${DOMAIN}`).pathname);
            if (!match) throw new Error(`Invalid Yaksha series URL: ${href}`);
            return {
                slug: match[1],
                title,
                coverUrl: new URL(cover.getAttribute('src') ?? '', `https://${DOMAIN}`).href,
                chapters: [...card.querySelectorAll('.list-chapter .chapter-item')].slice(0, 5).map(row => {
                    const chapterLink = row.querySelector<HTMLAnchorElement>('.chapter a');
                    const chapterHref = chapterLink?.getAttribute('href');
                    const label = chapterLink?.textContent?.replace(/\s+/g, ' ').trim();
                    if (!chapterHref || !label) throw new Error(`Yaksha chapter in ${match[1]} is incomplete`);
                    const path = new URL(chapterHref, `https://${DOMAIN}`).pathname.split('/').filter(Boolean);
                    const chapterId = path.at(-1);
                    if (!chapterId) throw new Error(`Invalid Yaksha chapter URL: ${chapterHref}`);
                    return {
                        chapterId,
                        label,
                        uploadedAt: row.querySelector<HTMLElement>('.post-on')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
                        locked: false,
                        unlockAt: null,
                    };
                }),
            };
        });
        const older = [...document.querySelectorAll<HTMLAnchorElement>('a')]
            .some(link => link.textContent?.replace(/\s+/g, ' ').trim() === 'Older Posts');
        return {
            series,
            nextCursor: older && series.length > 0 ? String(page + 1) : null,
        };
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
        const seriesTitle = bcMatch?.[1].trim();
        if (!seriesTitle) throw new Error('Chapter response did not contain the series title');

        return {
            chapterId: chapterId,
            seriesSlug: slug,
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
