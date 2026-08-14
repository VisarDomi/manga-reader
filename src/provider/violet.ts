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

const CHAPTER_RE = /\/(.+)-chapter-([^/]+)\/?$/;
const DOMAIN = SITE_CONFIG['violetscans'].domain;
const chapterRouteSlugs = new Map<string, string>();
const canonicalSeriesSlugs = new Map<string, string>();
const knownCanonicalSeriesSlugs = new Set<string>();

function chapterRouteKey(seriesSlug: string, chapterId: string): string {
    return `${seriesSlug}\u0000${chapterId}`;
}

function rememberSeriesIdentity(seriesSlug: string): void {
    const existing = canonicalSeriesSlugs.get(seriesSlug);
    if (existing !== undefined && existing !== seriesSlug) {
        throw new Error(`Violet slug ${seriesSlug} identifies both ${existing} and itself`);
    }
    knownCanonicalSeriesSlugs.add(seriesSlug);
    canonicalSeriesSlugs.set(seriesSlug, seriesSlug);
}

function rememberChapterRoute(seriesSlug: string, chapterId: string, routeSlug: string): void {
    rememberSeriesIdentity(seriesSlug);
    const key = chapterRouteKey(seriesSlug, chapterId);
    const existingRoute = chapterRouteSlugs.get(key);
    if (existingRoute !== undefined && existingRoute !== routeSlug) {
        throw new Error(`Violet series ${seriesSlug} chapter ${chapterId} has conflicting routes`);
    }
    const existingSeries = canonicalSeriesSlugs.get(routeSlug);
    if (existingSeries !== undefined && existingSeries !== seriesSlug) {
        throw new Error(`Violet chapter slug ${routeSlug} belongs to conflicting series`);
    }
    chapterRouteSlugs.set(key, routeSlug);
    canonicalSeriesSlugs.set(routeSlug, seriesSlug);
}

function canonicalSeriesSlug(slug: string): string {
    const mapped = canonicalSeriesSlugs.get(slug);
    if (mapped !== undefined) return mapped;
    if (knownCanonicalSeriesSlugs.has(slug)) return slug;
    throw new Error(`Unknown Violet series identity: ${slug}`);
}

function chapterRouteSlug(seriesSlug: string, chapterId: string): string {
    const canonical = canonicalSeriesSlug(seriesSlug);
    const routeSlug = chapterRouteSlugs.get(chapterRouteKey(canonical, chapterId));
    if (routeSlug === undefined) {
        throw new Error(`Violet series ${canonical} has no route for chapter ${chapterId}`);
    }
    return routeSlug;
}

function chapterRouteSlugForFetch(slug: string, chapterId: string): string {
    if (!knownCanonicalSeriesSlugs.has(slug) && !canonicalSeriesSlugs.has(slug)) return slug;
    return chapterRouteSlug(slug, chapterId);
}

function seriesSlugFromChapterHtml(html: string): string {
    const document = new DOMParser().parseFromString(html, 'text/html');
    const slugs = new Set<string>();
    for (const link of document.querySelectorAll<HTMLAnchorElement>('.allc a[href*="/comics/"]')) {
        const match = /^\/comics\/([^/]+)\/?$/.exec(new URL(link.href, `https://${DOMAIN}`).pathname);
        if (!match) throw new Error(`Invalid Violet chapter series URL: ${link.href}`);
        slugs.add(match[1]);
    }
    if (slugs.size === 0) throw new Error('Chapter response did not contain a Violet series URL');
    if (slugs.size !== 1) throw new Error('Chapter response contained ambiguous Violet series URLs');
    const first = slugs.values().next();
    if (first.done) throw new Error('Violet series URL invariant failed');
    return first.value;
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

function seriesIdentity(card: Element): { slug: string; title: string; coverUrl: string } {
    const link = card.querySelector<HTMLAnchorElement>('.bsx > a[href*="/comics/"]');
    const cover = card.querySelector<HTMLImageElement>('img');
    const title = text(card.querySelector('.tt'));
    const href = link?.getAttribute('href');
    if (!href || !cover || !title) throw new Error('Violet catalog card is incomplete');
    const coverSrc = cover.getAttribute('src');
    if (!coverSrc) throw new Error('Violet catalog card has no cover URL');
    const match = /^\/comics\/([^/]+)\/?$/.exec(new URL(href, `https://${DOMAIN}`).pathname);
    if (!match) throw new Error(`Invalid Violet series URL: ${href}`);
    return {
        slug: match[1],
        title,
        coverUrl: new URL(coverSrc, `https://${DOMAIN}`).href,
    };
}

function richHomeSeries(card: Element): HomePage['series'][number] {
    const identity = seriesIdentity(card);
    rememberSeriesIdentity(identity.slug);
    const chapterList = card.querySelector('.chapter-list');
    if (!chapterList) throw new Error(`Violet home card ${identity.slug} has no chapter list`);
    const chapters: HomePage['series'][number]['chapters'] = [];
    const chapterIds = new Set<string>();
    let allChaptersLinks = 0;
    for (const link of chapterList.querySelectorAll<HTMLAnchorElement>(':scope > a')) {
        const pathname = new URL(link.href, `https://${DOMAIN}`).pathname;
        if (pathname === `/comics/${identity.slug}/`) {
            allChaptersLinks += 1;
            continue;
        }
        const match = CHAPTER_RE.exec(pathname);
        if (!match) throw new Error(`Invalid Violet home chapter URL: ${link.href}`);
        const label = text(link.querySelector('.epxs'));
        if (!label) throw new Error(`Violet home chapter ${match[2]} has no label`);
        if (chapterIds.has(match[2])) {
            throw new Error(`Violet home card ${identity.slug} repeats chapter ${match[2]}`);
        }
        chapterIds.add(match[2]);
        rememberChapterRoute(identity.slug, match[2], match[1]);
        chapters.push({
            chapterId: match[2],
            label,
            uploadedAt: relativeDate(link.querySelector('.epxdate')),
            locked: link.querySelector('.fa-coins') !== null,
            unlockAt: null,
        });
    }
    if (allChaptersLinks !== 1) {
        throw new Error(`Violet home card ${identity.slug} has ${allChaptersLinks} All Chapters links`);
    }
    return { ...identity, chapters: chapters.slice(0, 5) };
}

const AJAX_PAGE_SIZE = 12;

function ajaxCursor(cursor: string): number {
    const match = /^ajax:(\d+)$/.exec(cursor);
    const page = Number(match?.[1]);
    if (!match || !Number.isSafeInteger(page) || page < 2) {
        throw new Error(`Invalid Violet home cursor: ${cursor}`);
    }
    return page;
}

export const violet: Provider = {
    key: 'violetscans',
    documentTitle: SITE_CONFIG.violetscans.documentTitle,

    matchRoute(pathname: string, hash: string): RouteMatch | null {
        if (pathname === '/') return { handler: Handler.Home };
        const m = CHAPTER_RE.exec(pathname);
        if (!m) return null;
        return { handler: Handler.Reader, slug: m[1], chapterId: m[2], imageIndex: hashImageIndex(hash) };
    },

    async fetchHome(cursor: string | null): Promise<HomePage> {
        if (cursor === null) {
            const res = await fetch(`https://${DOMAIN}/`);
            if (!res.ok) throw new Error(`Latest series failed: ${res.status}`);
            const document = new DOMParser().parseFromString(await res.text(), 'text/html');
            const latest = document.querySelector('.violet-latest-comics');
            if (!latest) throw new Error('Violet home did not contain Latest Comics');
            const series = [...latest.querySelectorAll('.latest-updates .bs')].map(richHomeSeries);
            if (series.length === 0) throw new Error('Violet Latest Comics is empty');
            return { series, nextCursor: 'ajax:2' };
        }

        const page = ajaxCursor(cursor);
        const body = new URLSearchParams({
            action: 'load_more_manga_posts',
            page: String(page),
        });
        const res = await fetch(`https://${DOMAIN}/wp-admin/admin-ajax.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body,
        });
        if (!res.ok) throw new Error(`Series catalog failed: ${res.status}`);
        const document = new DOMParser().parseFromString(await res.text(), 'text/html');
        const series = [...document.querySelectorAll('.bs')].map(richHomeSeries);
        if (series.length === 0) throw new Error(`Violet manga page ${page} is empty`);
        return {
            series,
            nextCursor: series.length < AJAX_PAGE_SIZE ? null : `ajax:${page + 1}`,
        };
    },


    async fetchChapter(slug: string, chapterId: string): Promise<ChapterData | null> {
        const routeSlug = chapterRouteSlugForFetch(slug, chapterId);
        const url = `https://${DOMAIN}/${routeSlug}-chapter-${chapterId}/`;
        const res = await fetch(url);
        if (isChapterUnavailable(res)) return null;
        const html = await res.text();
        const seriesSlug = seriesSlugFromChapterHtml(html);
        rememberChapterRoute(seriesSlug, chapterId, routeSlug);
        if (html.includes('class="lock-status"')) return null;

        // Extract ts_reader.run({...}) JSON payload
        const tsMatch = /ts_reader\.run\((\{[\s\S]*?\})\);?\s*<\/script>/u.exec(html);
        if (!tsMatch) throw new Error('Chapter response did not contain reader data');

        const raw = tsMatch[1];
        const data = JSON.parse(raw) as unknown;
        const srcs = defaultReaderImages(data);

        const images: ChapterImage[] = srcs.map((url: string) => ({ url }));

        // HISTORY is Violet's structured chapter identity payload.
        const histMatch = /HISTORY\.push\(\d+,\s*(\{[\s\S]*?\})\);?/u.exec(html);
        if (!histMatch) throw new Error('Chapter response did not contain Violet history data');
        const history = JSON.parse(histMatch[1]) as unknown;
        if (typeof history !== 'object' || history === null) {
            throw new Error('Violet history data is not an object');
        }
        const seriesTitle = (history as { manga_title?: unknown }).manga_title;
        if (typeof seriesTitle !== 'string' || seriesTitle.trim() === '') {
            throw new Error('Violet history data has no series title');
        }

        return {
            chapterId: chapterId,
            seriesSlug,
            seriesTitle: seriesTitle.trim(),
            images,
        };
    },

    async fetchChaptersNewestFirst(slug: string): Promise<ChapterMeta[]> {
        const seriesSlug = canonicalSeriesSlug(slug);
        const url = `https://${DOMAIN}/comics/${seriesSlug}/`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Series page not found: ${res.status}`);
        const document = new DOMParser().parseFromString(await res.text(), 'text/html');
        const chapterList = document.querySelector('#chapterlist > ul');
        if (!chapterList) throw new Error('Violet series page did not contain a chapter list');
        const chapters: ChapterMeta[] = [];
        const chapterIds = new Set<string>();
        for (const item of chapterList.children) {
            if (!(item instanceof HTMLLIElement)) throw new Error('Violet chapter list contained a non-list item');
            const chapterId = item.getAttribute('data-num');
            if (!chapterId) throw new Error('Violet chapter list item has no chapter number');
            const link = item.querySelector<HTMLAnchorElement>(':scope > a');
            if (!link) throw new Error(`Violet chapter ${chapterId} has no link element`);
            const href = link.getAttribute('href');
            if (href === null) {
                if (link.dataset.bsTarget !== '#lockedChapterModal' || !link.dataset.id || !link.dataset.coin) {
                    throw new Error(`Violet chapter ${chapterId} has neither a URL nor lock metadata`);
                }
                continue;
            }
            const match = CHAPTER_RE.exec(new URL(href, `https://${DOMAIN}`).pathname);
            if (!match) throw new Error(`Invalid Violet series chapter URL: ${href}`);
            if (match[2] !== chapterId) {
                throw new Error(`Violet chapter URL ${href} does not match chapter ${chapterId}`);
            }
            if (chapterIds.has(chapterId)) throw new Error(`Violet chapter list repeats chapter ${chapterId}`);
            chapterIds.add(chapterId);
            rememberChapterRoute(seriesSlug, chapterId, match[1]);
            chapters.push({ chapterId });
        }
        return chapters;
    },

    readerUrl(slug: string, chapterId: string, imageIndex?: string): string {
        const routeSlug = chapterRouteSlug(slug, chapterId);
        return `https://${DOMAIN}/${routeSlug}-chapter-${chapterId}/${imageIndex ? `#${imageIndex}` : ''}`;
    },

    seriesUrl(slug: string): string {
        return `https://${DOMAIN}/comics/${canonicalSeriesSlug(slug)}/`;
    },
};
