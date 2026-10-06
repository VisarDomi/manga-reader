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
import { chapterLoader, homeDestinationResolver } from './actions';

// WordPress may append a numeric collision suffix after the public chapter number.
// Example: /worlds-strongest-troll-chapter-194-2/ is Chapter 194.
const CHAPTER_SUFFIX_RE = /-chapter-(\d+(?:\.\d+)?)(?:-\d+)?$/;
const DOMAIN = SITE_CONFIG['scythescans'].domain;

enum ScytheHomeSource {
    Home,
    Catalog,
}

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

function homeCursor(cursor: string | null): { source: ScytheHomeSource; page: number } {
    if (cursor === null) return { source: ScytheHomeSource.Home, page: 1 };
    const match = /^(home|catalog):(\d+)$/.exec(cursor);
    const page = Number(match?.[2]);
    if (!match || !Number.isSafeInteger(page) || page < 1) {
        throw new Error(`Invalid Scythe home cursor: ${cursor}`);
    }
    return {
        source: match[1] === 'home' ? ScytheHomeSource.Home : ScytheHomeSource.Catalog,
        page,
    };
}

// The page's base64-encoded ts_reader.run({...}) JSON.
function readerData(html: string): unknown {
    const b64Match = html.match(/<script defer src="data:text\/javascript;base64,([A-Za-z0-9+/=]+)"><\/script>/g);
    for (const tag of b64Match ?? []) {
        const b64 = tag.match(/base64,([A-Za-z0-9+/=]+)/);
        if (!b64) continue;
        const decoded = atob(b64[1]);
        if (decoded.includes('ts_reader.run(')) {
            const jsonMatch = /^ts_reader\.run\((\{[\s\S]*\})\);?$/u.exec(decoded.trim());
            if (jsonMatch) return JSON.parse(jsonMatch[1]) as unknown;
            break;
        }
    }
    throw new Error('Chapter response did not contain reader data');
}

async function fetchScytheChapter(slug: string, chapterId: string): Promise<ChapterData | null> {
    const url = `https://${DOMAIN}/${chapterId}/`;
    const res = await fetch(url);
    if (isChapterUnavailable(res)) return null;
    const html = await res.text();

    const tsData = readerData(html);
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

async function fetchDocument(url: string, failure: string): Promise<Document> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${failure}: ${res.status}`);
    return new DOMParser().parseFromString(await res.text(), 'text/html');
}

function latestUpdateSeries(document: Document): HomePage['series'] {
    const latest = [...document.querySelectorAll('.bixbox')].find(box =>
        text(box.querySelector('.releases h2')) === 'Latest Update'
    );
    if (!latest) throw new Error('Scythe home did not contain Latest Update');
    const series = [...latest.querySelectorAll('.listupd .bs')].map(richHomeSeries);
    if (series.length === 0) throw new Error('Scythe Latest Update is empty');
    return series;
}

async function fetchListedChapters(slug: string): Promise<ChapterMeta[]> {
    const document = await fetchDocument(`https://${DOMAIN}/manga/${slug}/`, 'Manga page not found');
    const chapters: ChapterMeta[] = [];
    const seen = new Set<string>();
    for (const link of document.querySelectorAll<HTMLAnchorElement>('#chapterlist a[href]')) {
        const route = chapterRoute(new URL(link.href, `https://${DOMAIN}`).pathname);
        if (!route || route.slug !== slug) throw new Error(`Invalid Scythe chapter-list URL: ${link.href}`);
        if (seen.has(route.chapterId)) continue;
        seen.add(route.chapterId);
        chapters.push({ chapterId: route.chapterId });
    }
    if (chapters.length === 0) throw new Error('Scythe chapter list is empty');
    return chapters;
}

// The series' newest chapters on the first Latest Update page, newest first.
async function fetchLatestChapters(slug: string): Promise<ChapterMeta[]> {
    const document = await fetchDocument(`https://${DOMAIN}/`, 'Latest series failed');
    const series = latestUpdateSeries(document).find(entry => entry.slug === slug);
    return series?.chapters.map(chapter => ({ chapterId: chapter.chapterId })) ?? [];
}

async function previousChapterId(slug: string, chapterId: string, signal: AbortSignal): Promise<string | null> {
    const res = await fetch(`https://${DOMAIN}/${chapterId}/`, { signal });
    if (isChapterUnavailable(res)) return null;
    const prevUrl = (readerData(await res.text()) as { prevUrl?: unknown }).prevUrl;
    if (typeof prevUrl !== 'string' || prevUrl === '') return null;
    const route = chapterRoute(new URL(prevUrl, `https://${DOMAIN}`).pathname);
    return route?.slug === slug ? route.chapterId : null;
}

// Most chapters missing from the cached list that are filled in through
// previous-chapter links, and the time allowed for them, before the cached list
// is used as it is. An uncached chapter page can take longer than a minute.
const MAX_CHAPTER_GAP = 10;
const CHAPTER_GAP_MS = 10_000;

// Scythe's origin renders an uncached page slowly (6 to 85 s measured, past the
// app's 20 s request timeout), so this reads only Cloudflare-cached pages. The
// cached series page is not purged when a chapter is published and can omit the
// newest chapters; the first Latest Update page is purged, so the series' newest
// chapters there are added in front. A chapter page's previous link (set when it
// is published) connects them when the cached list is further behind.
async function fetchScytheChaptersNewestFirst(slug: string): Promise<ChapterMeta[]> {
    const [listed, latest] = await Promise.all([
        fetchListedChapters(slug),
        fetchLatestChapters(slug).catch((error: unknown) => {
            console.error(error);
            return [];
        }),
    ]);
    const listedIds = new Set(listed.map(chapter => chapter.chapterId));
    const newer: ChapterMeta[] = [];
    for (const chapter of latest) {
        if (listedIds.has(chapter.chapterId)) return [...newer, ...listed];
        newer.push(chapter);
    }
    if (newer.length === 0) return listed;

    const gap = new AbortController();
    const deadline = setTimeout(() => gap.abort(), CHAPTER_GAP_MS);
    try {
        let oldest = newer[newer.length - 1].chapterId;
        for (let step = 0; step < MAX_CHAPTER_GAP; step++) {
            const previous = await previousChapterId(slug, oldest, gap.signal);
            if (previous === null) break;
            if (listedIds.has(previous)) return [...newer, ...listed];
            newer.push({ chapterId: previous });
            oldest = previous;
        }
    } catch (error) {
        console.error(error);
    } finally {
        clearTimeout(deadline);
    }
    // Never return a list with a hole in it; the next refresh retries.
    return listed;
}

function scytheReaderUrl(_slug: string, chapterId: string, imageIndex?: string): string {
    return `https://${DOMAIN}/${chapterId}/${imageIndex ? `#${imageIndex}` : ''}`;
}

function scytheSeriesUrl(slug: string): string {
    return `https://${DOMAIN}/manga/${slug}/`;
}

export const scythe: Provider = {
    key: 'scythescans',

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
        if (source === ScytheHomeSource.Home) {
            const url = page === 1 ? `https://${DOMAIN}/` : `https://${DOMAIN}/page/${page}/`;
            const document = await fetchDocument(url, 'Latest series failed');
            const series = latestUpdateSeries(document);
            return {
                series,
                nextCursor: document.querySelector('.pagination a.next')
                    ? `home:${page + 1}`
                    : 'catalog:1',
            };
        }

        const res = await fetch(`https://${DOMAIN}/manga/?status&type&order=update&page=${page}`);
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


    loadChapter: chapterLoader(fetchScytheChapter, scytheSeriesUrl),
    resolveHomeDestination: homeDestinationResolver({
        fetchChapter: fetchScytheChapter,
        fetchChaptersNewestFirst: fetchScytheChaptersNewestFirst,
        readerUrl: scytheReaderUrl,
        seriesUrl: scytheSeriesUrl,
    }),
    fetchChaptersNewestFirst: fetchScytheChaptersNewestFirst,
    readerUrl: scytheReaderUrl,
    seriesUrl: scytheSeriesUrl,
};
