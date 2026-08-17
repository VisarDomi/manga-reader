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
import { fetchValirHome } from './valir-catalog';
import { lastImageIndexFrom, percentImageIndexFrom } from './resume';
import { decryptValirPage } from './valir-tiles';

const DOMAIN = SITE_CONFIG['valirscans'].domain;
const CHAPTER_RE = /^\/series\/comic\/([^/]+)\/chapter\/(\d+)/;
const FLIGHT_PUSH = 'self.__next_f.push(';

async function fetchValirChapter(slug: string, chapterId: string): Promise<ChapterData | null> {
    const pageUrl = `https://${DOMAIN}/series/comic/${slug}/chapter/${chapterId}`;
    const res = await fetch(pageUrl);
    if (isChapterUnavailable(res)) return null;
    const html = await res.text();

    // Extract chapter metadata from the RSC payload
    const chapterMatch = /\\"chapter\\":\s*\{[^}]*\\"id\\":\s*\\"([^"\\]+)\\"[^}]*\\"number\\":\s*(\d+)[^}]*\\"title\\":\s*\\"([^"\\]*)\\"/.exec(html);
    if (!chapterMatch) throw new Error('Could not find chapter data in page');

    const numericId = chapterMatch[1]; // cuid2 chapter ID

    // Extract series data
    const seriesMatch = /\\"series\\":\s*\{[^}]*\\"id\\":\s*\\"([^"\\]+)\\"[^}]*\\"title\\":\s*\\"([^"\\]*)\\"/.exec(html);
    if (!seriesMatch) throw new Error('Could not find series data in page');
    const seriesId = seriesMatch[1];
    const seriesTitle = seriesMatch[2];

    const pages = parseValirPages(html);

    const images: ChapterImage[] = [];
    for (const page of pages) {
        images.push(page.encrypted
            ? { url: await decryptValirPage(page.pageId, page.width, page.height), width: page.width, height: page.height }
            : { url: page.url, width: page.width, height: page.height });
    }

    return {
        chapterId,
        seriesSlug: slug,
        seriesTitle: seriesTitle,
        seriesApiId: seriesId,
        chapterApiId: numericId,
        images,
    };
}

interface ValirPageRecord {
    pageId: string;
    pageNumber: number;
    url: string;
    width: number;
    height: number;
    encrypted: boolean;
}

/**
 * Extract the current chapter's page records from the RSC payload.
 * The chapter record nests its pages: {"chapter":{"id":...,"pages":[...]}}.
 * Field-level regexes are unsafe here (they can span from the chapter id
 * into the nested pages), so the pages array is extracted with a balanced
 * bracket scan and parsed as JSON.
 */
export function parseValirPages(html: string): ValirPageRecord[] {
    const chapterMarker = '\\"chapter\\":{';
    const pagesMarker = '\\"pages\\":';
    const chapterStart = html.indexOf(chapterMarker);
    if (chapterStart === -1) throw new Error('Could not find chapter data in page');
    const pagesStart = html.indexOf(pagesMarker, chapterStart);
    if (pagesStart === -1) throw new Error('Chapter response contained no pages');
    const arrayText = jsonArrayAtEscaped(html, pagesStart + pagesMarker.length);
    const rawPages = JSON.parse(arrayText.replace(/\\"/g, '"').replace(/\\\\/g, '\\')) as unknown;
    if (!Array.isArray(rawPages) || rawPages.length === 0) {
        throw new Error('Chapter response contained no images');
    }
    const pages = rawPages.map((entry, index) => {
        if (typeof entry !== 'object' || entry === null) {
            throw new Error('Valir page ' + index + ' is not an object');
        }
        const page = entry as {
            id?: unknown;
            pageNumber?: unknown;
            imageUrl?: unknown;
            width?: unknown;
            height?: unknown;
            isEncrypted?: unknown;
        };
        if (typeof page.id !== 'string' || page.id.length === 0) {
            throw new Error('Valir page ' + index + ' has no id');
        }
        if (typeof page.pageNumber !== 'number' || !Number.isSafeInteger(page.pageNumber)) {
            throw new Error('Valir page ' + index + ' has an invalid pageNumber');
        }
        if (typeof page.imageUrl !== 'string') {
            throw new Error('Valir page ' + index + ' has no imageUrl');
        }
        return {
            pageId: page.id,
            pageNumber: page.pageNumber,
            url: page.imageUrl,
            width: typeof page.width === 'number' ? page.width : 800,
            height: typeof page.height === 'number' ? page.height : 1200,
            encrypted: page.isEncrypted === true,
        };
    }).sort((left, right) => left.pageNumber - right.pageNumber);

    if (pages.some((page, index) => page.pageNumber !== index + 1)) {
        throw new Error('Chapter response contained invalid page ordering');
    }
    return pages;
}

async function fetchValirChaptersNewestFirst(slug: string): Promise<ChapterMeta[]> {
    // Fetch the first chapter page — it contains the allChapters array for this series
    const pageUrl = `https://${DOMAIN}/series/comic/${slug}/chapter/1`;
    const res = await fetch(pageUrl);
    if (!res.ok) throw new Error(`Chapter page not found: ${res.status}`);
    const html = await res.text();

    return parseValirChapters(html);
}

function valirDocumentReady(): boolean {
    return [...document.scripts].some(script => script.textContent?.includes(FLIGHT_PUSH));
}

export function waitForValirTakeover(): Promise<void> {
    if (valirDocumentReady()) return Promise.resolve();

    return new Promise(resolve => {
        const observer = new MutationObserver(() => {
            if (!valirDocumentReady()) return;
            observer.disconnect();
            resolve();
        });
        observer.observe(document, { childList: true, subtree: true });
    });
}

function jsonArrayAt(value: string, start: number): string {
    if (value[start] !== '[') throw new Error('Expected a JSON array');
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
        const character = value[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') inString = false;
            continue;
        }
        if (character === '"') inString = true;
        else if (character === '[') depth += 1;
        else if (character === ']' && --depth === 0) return value.slice(start, index + 1);
    }
    throw new Error('JSON array was not terminated');
}

function flightPayloads(html: string): string[] {
    const document = new DOMParser().parseFromString(html, 'text/html');
    const payloads: string[] = [];
    for (const script of document.querySelectorAll('script')) {
        const source = script.textContent ?? '';
        let searchFrom = 0;
        while (true) {
            const push = source.indexOf(FLIGHT_PUSH, searchFrom);
            if (push === -1) break;
            const tupleStart = push + FLIGHT_PUSH.length;
            const tupleJson = jsonArrayAt(source, tupleStart);
            const tuple = JSON.parse(tupleJson) as unknown;
            if (!Array.isArray(tuple)) throw new Error('Valir flight push is not a tuple');
            if (tuple[0] === 1) {
                if (typeof tuple[1] !== 'string') throw new Error('Valir flight payload is not a string');
                payloads.push(tuple[1]);
            }
            searchFrom = tupleStart + tupleJson.length;
        }
    }
    return payloads;
}


/**
 * Balanced-array extraction over the ESCAPED RSC text: \" sequences are
 * string delimiters, and any character after a backslash is skipped so
 * escaped quotes/backslashes cannot corrupt the bracket count.
 */
function jsonArrayAtEscaped(source: string, start: number): string {
    if (source[start] !== '[') throw new Error('Expected a JSON array');
    let depth = 0;
    for (let index = start; index < source.length; index++) {
        const character = source[index];
        if (character === '\\') { index++; continue; }
        if (character === '[') depth++;
        else if (character === ']' && --depth === 0) return source.slice(start, index + 1);
    }
    throw new Error('JSON array was not terminated');
}

export function parseValirChapters(html: string): ChapterMeta[] {
    const flight = flightPayloads(html).join('');
    const markers = [...flight.matchAll(/"allChapters"\s*:/g)];
    if (markers.length !== 1) {
        throw new Error(`Expected one Valir chapter list, found ${markers.length}`);
    }
    let arrayStart = markers[0].index + markers[0][0].length;
    while (/\s/.test(flight[arrayStart] ?? '')) arrayStart += 1;
    const value = JSON.parse(jsonArrayAt(flight, arrayStart)) as unknown;
    if (!Array.isArray(value) || value.length === 0) throw new Error('Valir chapter list is empty');

    const chapters = value.map((chapter, index): ChapterMeta => {
        if (typeof chapter !== 'object' || chapter === null) {
            throw new Error(`Valir chapter ${index} is not an object`);
        }
        const { id, number } = chapter as { id?: unknown; number?: unknown };
        if (typeof id !== 'string' || id.trim() === '') {
            throw new Error(`Valir chapter ${index} has no ID`);
        }
        if (!Number.isSafeInteger(number) || (number as number) <= 0) {
            throw new Error(`Valir chapter ${index} has an invalid number`);
        }
        return { chapterId: String(number), chapterApiId: id };
    });
    for (let index = 1; index < chapters.length; index += 1) {
        if (Number(chapters[index - 1].chapterId) >= Number(chapters[index].chapterId)) {
            throw new Error('Valir chapters are not uniquely ordered oldest first');
        }
    }
    return chapters.reverse();
}

export const valir: Provider = {
    key: 'valirscans',
    catalogInWorker: true,
    remoteHistoryInWorker: true,
    documentTitle: SITE_CONFIG.valirscans.documentTitle,
    waitForTakeover: waitForValirTakeover,

    matchRoute(pathname: string, hash: string): RouteMatch | null {
        if (pathname === '/') return { handler: Handler.Home };
        const m = CHAPTER_RE.exec(pathname);
        if (!m) return null;
        return { handler: Handler.Reader, slug: m[1], chapterId: m[2], imageIndex: hashImageIndex(hash) };
    },

    async fetchHome(cursor: string | null): Promise<HomePage> {
        return fetchValirHome(cursor);
    },

    async fetchChapter(slug: string, chapterId: string): Promise<ChapterData | null> {
        return fetchValirChapter(slug, chapterId);
    },

    lastReadImageIndex: lastImageIndexFrom(fetchValirChapter),
    resumeImageIndex: percentImageIndexFrom(fetchValirChapter),

    async fetchChaptersNewestFirst(slug: string): Promise<ChapterMeta[]> {
        return fetchValirChaptersNewestFirst(slug);
    },

    readerUrl(slug: string, chapterId: string, imageIndex?: string): string {
        return `https://${DOMAIN}/series/comic/${slug}/chapter/${chapterId}${imageIndex ? `#${imageIndex}` : ''}`;
    },

    seriesUrl(slug: string): string {
        return `https://${DOMAIN}/series/comic/${slug}`;
    },
};