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
import { lastImageIndexFrom, percentImageIndexFrom } from './resume';

// WordPress may append a numeric collision suffix after the public chapter number.
// Example: /worlds-strongest-troll-chapter-194-2/ is Chapter 194.
const CHAPTER_SUFFIX_RE = /-chapter-(\d+(?:\.\d+)?)(?:-\d+)?$/;
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

function chapterRoute(pathname: string): { slug: string; chapterId: string; chapterNumber: string } | null {
    const chapterId = pathname.split('/').filter(Boolean).at(-1);
    if (!chapterId || pathname.split('/').filter(Boolean).length !== 1) return null;
    const suffix = CHAPTER_SUFFIX_RE.exec(chapterId);
    if (!suffix || suffix.index === 0) return null;
    return {
        slug: chapterId.slice(0, suffix.index),
        chapterId,
        chapterNumber: suffix[1],
    };
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
            const route = chapterRoute(new URL(link.href, `https://${DOMAIN}`).pathname);
            if (!route || route.slug !== identity.slug) {
                throw new Error(`Invalid Scythe home chapter URL: ${link.href}`);
            }
            return {
                chapterId: route.chapterId,
                label: `Chapter ${route.chapterNumber}`,
                uploadedAt: relativeDate(link.querySelector('.fivtime')),
                locked: false,
                unlockAt: null,
            };
        });
    if (chapters.length === 0) throw new Error(`Scythe home card ${identity.slug} has no chapters`);
    return { ...identity, chapters: chapters.slice(0, 5) };
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

async function fetchScytheChapter(slug: string, chapterId: string): Promise<ChapterData | null> {
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
        seriesSlug: slug,
        seriesTitle: seriesTitle,
        images,
    };
}

export const scythe: Provider = {
    key: 'scythescans',
    documentTitle: SITE_CONFIG.scythescans.documentTitle,

    matchRoute(pathname: string, hash: string): RouteMatch | null {
        if (pathname === '/') return { handler: Handler.Home };
        const route = chapterRoute(pathname);
        if (!route) return null;
        return {
            handler: Handler.Reader,
            slug: route.slug,
            chapterId: route.chapterId,
            imageIndex: hashImageIndex(hash),
        };
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


    async fetchChapter(slug: string, chapterId: string): Promise<ChapterData | null> {
        return fetchScytheChapter(slug, chapterId);
    },

    lastReadImageIndex: lastImageIndexFrom(fetchScytheChapter),
    resumeImageIndex: percentImageIndexFrom(fetchScytheChapter),

    async fetchChaptersNewestFirst(slug: string): Promise<ChapterMeta[]> {
        const url = `https://${DOMAIN}/manga/${slug}/`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Manga page not found: ${res.status}`);
        const document = new DOMParser().parseFromString(await res.text(), 'text/html');
        const chapters: ChapterMeta[] = [];
        const seen = new Set<string>();
        for (const link of document.querySelectorAll<HTMLAnchorElement>('#chapterlist a[href]')) {
            const route = chapterRoute(new URL(link.href, `https://${DOMAIN}`).pathname);
            if (!route || route.slug !== slug) {
                throw new Error(`Invalid Scythe chapter-list URL: ${link.href}`);
            }
            if (seen.has(route.chapterId)) continue;
            seen.add(route.chapterId);
            chapters.push({ chapterId: route.chapterId });
        }
        if (chapters.length === 0) throw new Error('Scythe chapter list is empty');
        return chapters;
    },

    readerUrl(_slug: string, chapterId: string, imageIndex?: string): string {
        return `https://${DOMAIN}/${chapterId}/${imageIndex ? `#${imageIndex}` : ''}`;
    },

    seriesUrl(slug: string): string {
        return `https://${DOMAIN}/manga/${slug}/`;
    },
};