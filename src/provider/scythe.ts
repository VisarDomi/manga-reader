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
import { defaultReaderImages } from './ts-reader';

// URL: /<slug>-chapter-<number>/
const CHAPTER_RE = /^\/(.+)-chapter-(\d+(?:\.\d+)?)\/?$/;
const DOMAIN = SITE_CONFIG['scythescans'].domain;

function text(element: Element | null): string {
    return element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function relativeDate(element: Element | null): string | null {
    const value = text(element);
    if (value === '') return null;
    return /^\d+\s+(?:minute|hour|day|week|month|year)s?$/i.test(value)
        ? `${value} ago`
        : value;
}

function seriesIdentity(card: Element): { slug: string; title: string; coverUrl: string } {
    const link = card.querySelector<HTMLAnchorElement>('.bsx > a[href*="/manga/"]');
    const cover = card.querySelector<HTMLImageElement>('img');
    const title = text(card.querySelector('.tt'));
    if (!link || !cover || !title) throw new Error('Scythe catalog card is incomplete');
    const match = /^\/manga\/([^/]+)\/?$/.exec(new URL(link.href, `https://${DOMAIN}`).pathname);
    if (!match) throw new Error(`Invalid Scythe series URL: ${link.href}`);
    return {
        slug: match[1],
        title,
        coverUrl: new URL(cover.getAttribute('src') ?? '', `https://${DOMAIN}`).href,
    };
}

function richHomeSeries(card: Element): HomePage['series'][number] {
    const identity = seriesIdentity(card);
    const chapters = [...card.querySelectorAll<HTMLAnchorElement>('ul.chfiv > li > a')]
        .map(link => {
            const match = CHAPTER_RE.exec(new URL(link.href, `https://${DOMAIN}`).pathname);
            if (!match || match[1] !== identity.slug) {
                throw new Error(`Invalid Scythe home chapter URL: ${link.href}`);
            }
            return {
                chapterId: `${identity.slug}-chapter-${match[2]}`,
                label: `Chapter ${match[2]}`,
                uploadedAt: relativeDate(link.querySelector('.fivtime')),
                locked: false,
                unlockAt: null,
            };
        });
    if (chapters.length === 0) throw new Error(`Scythe home card ${identity.slug} has no chapters`);
    return { ...identity, chapters: chapters.slice(0, 3) };
}

function catalogSeries(card: Element): HomePage['series'][number] {
    const identity = seriesIdentity(card);
    const chapterNumber = text(card.querySelector('.epxs'))
        .match(/^Chapter\s+(\d+(?:\.\d+)?)/i)?.[1];
    return {
        ...identity,
        chapters: chapterNumber ? [{
            chapterId: `${identity.slug}-chapter-${chapterNumber}`,
            label: `Chapter ${chapterNumber}`,
            uploadedAt: null,
            locked: false,
            unlockAt: null,
        }] : [],
    };
}

function homeCursor(cursor: string | null): { source: 'home' | 'catalog'; page: number } {
    if (cursor === null) return { source: 'home', page: 1 };
    const match = /^(home|catalog):(\d+)$/.exec(cursor);
    const page = Number(match?.[2]);
    if (!match || !Number.isSafeInteger(page) || page < 1) {
        throw new Error(`Invalid Scythe home cursor: ${cursor}`);
    }
    return { source: match[1] as 'home' | 'catalog', page };
}

export const scythe: Provider = {
    key: 'scythescans',
    documentTitle: SITE_CONFIG.scythescans.documentTitle,

    matchRoute(pathname: string, hash: string): RouteMatch | null {
        if (pathname === '/') return { handler: Handler.Home };
        const m = CHAPTER_RE.exec(pathname);
        if (!m) return null;
        const chapterSlug = `${m[1]}-chapter-${m[2]}`;
        return { handler: Handler.Reader, slug: m[1], chapterId: chapterSlug, imageIndex: hashImageIndex(hash) };
    },

    async fetchHome(cursor: string | null): Promise<HomePage> {
        const { source, page } = homeCursor(cursor);
        if (source === 'home') {
            const url = page === 1 ? `https://${DOMAIN}/` : `https://${DOMAIN}/page/${page}/`;
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Latest series failed: ${res.status}`);
            const document = new DOMParser().parseFromString(await res.text(), 'text/html');
            const latest = [...document.querySelectorAll('.bixbox')].find(box =>
                text(box.querySelector('.releases h2')) === 'Latest Update'
            );
            if (!latest) throw new Error('Scythe home did not contain Latest Update');
            const series = [...latest.querySelectorAll('.listupd .bs')].map(richHomeSeries);
            if (series.length === 0) throw new Error('Scythe Latest Update is empty');
            return {
                series,
                nextCursor: document.querySelector('.pagination a.next')
                    ? `home:${page + 1}`
                    : 'catalog:1',
            };
        }

        const res = await fetch(`https://${DOMAIN}/manga/?order=update&page=${page}`);
        if (!res.ok) throw new Error(`Series catalog failed: ${res.status}`);
        const document = new DOMParser().parseFromString(await res.text(), 'text/html');
        const series = [...document.querySelectorAll('.listupd .bs')].map(catalogSeries);
        return {
            series,
            nextCursor: document.querySelector('.pagination a.next') && series.length > 0
                ? `catalog:${page + 1}`
                : null,
        };
    },


    async fetchChapter(_slug: string, chapterId: string): Promise<ChapterData | null> {
        const url = `https://${DOMAIN}/${chapterId}/`;
        const res = await fetch(url);
        if (isChapterUnavailable(res)) return null;
        const html = await res.text();

        // Extract base64-encoded ts_reader.run({...}) JSON
        let tsData: unknown;
        const b64Match = html.match(/<script defer src="data:text\/javascript;base64,([A-Za-z0-9+/=]+)"><\/script>/g);
        if (b64Match) {
            for (const tag of b64Match) {
                const b64 = tag.match(/base64,([A-Za-z0-9+/=]+)/);
                if (!b64) continue;
                const decoded = atob(b64[1]);
                if (decoded.includes('ts_reader.run(')) {
                    const jsonMatch = /^ts_reader\.run\((\{[\s\S]*\})\);?$/u.exec(decoded.trim());
                    if (jsonMatch) {
                        tsData = JSON.parse(jsonMatch[1]) as unknown;
                    }
                    break;
                }
            }
        }

        if (tsData === undefined) throw new Error('Chapter response did not contain reader data');
        const srcs = defaultReaderImages(tsData);

        const images: ChapterImage[] = srcs.map(url => ({ url }));

        // Series title from .allc div
        const seriesMatch = /<div class="allc">All chapters are in <a[^>]*>([^<]+)<\/a><\/div>/.exec(html);
        const seriesTitle = seriesMatch?.[1].trim();
        if (!seriesTitle) throw new Error('Chapter response did not contain the series title');

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
