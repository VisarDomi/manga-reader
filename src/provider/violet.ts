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
    const match = /^\/comics\/([^/]+)\/?$/.exec(new URL(href, `https://${DOMAIN}`).pathname);
    if (!match) throw new Error(`Invalid Violet series URL: ${href}`);
    return {
        slug: match[1],
        title,
        coverUrl: new URL(cover.getAttribute('src') ?? '', `https://${DOMAIN}`).href,
    };
}

function richHomeSeries(card: Element): HomePage['series'][number] {
    const identity = seriesIdentity(card);
    const chapters = [...card.querySelectorAll<HTMLAnchorElement>('.chapter-list > a')]
        .flatMap(link => {
            const match = CHAPTER_RE.exec(new URL(link.href, `https://${DOMAIN}`).pathname);
            if (!match) return [];
            if (match[1] !== identity.slug) {
                throw new Error(`Invalid Violet home chapter URL: ${link.href}`);
            }
            const label = text(link.querySelector('.epxs'));
            if (!label) throw new Error(`Violet home chapter ${match[2]} has no label`);
            return [{
                chapterId: match[2],
                label,
                uploadedAt: relativeDate(link.querySelector('.epxdate')),
                locked: link.querySelector('.fa-coins') !== null,
                unlockAt: null,
            }];
        });
    if (chapters.length === 0) throw new Error(`Violet home card ${identity.slug} has no chapters`);
    return { ...identity, chapters: chapters.slice(0, 3) };
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
        const url = `https://${DOMAIN}/${slug}-chapter-${chapterId}/`;
        const res = await fetch(url);
        if (isChapterUnavailable(res)) return null;
        const html = await res.text();
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
            seriesTitle: seriesTitle.trim(),
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

    readerUrl(slug: string, chapterId: string, imageIndex?: string): string {
        return `https://${DOMAIN}/${slug}-chapter-${chapterId}/${imageIndex ? `#${imageIndex}` : ''}`;
    },

    seriesUrl(slug: string): string {
        return `https://${DOMAIN}/comics/${slug}/`;
    },
};
