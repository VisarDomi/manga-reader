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

    // A chapter's public RSC payload is the authoritative page source.
    // Anchor on the complete page-record shape so nested fragment imageUrl
    // fields cannot be mistaken for reader pages.
    const pageDataRe = /\\"id\\":\s*\\"([^"\\]+)\\"\s*,\s*\\"pageNumber\\":\s*(\d+)\s*,\s*\\"imageUrl\\":\s*\\"([^"\\]+)\\"\s*,\s*\\"width\\":\s*(\d+)\s*,\s*\\"height\\":\s*(\d+)\s*,\s*\\"isEncrypted\\":\s*(?:true|false)/g;
    const pages = [...html.matchAll(pageDataRe)]
        .map(match => ({
            pageNumber: parseInt(match[2], 10),
            image: {
                url: match[3],
                width: parseInt(match[4], 10),
                height: parseInt(match[5], 10),
            } satisfies ChapterImage,
        }))
        .sort((left, right) => left.pageNumber - right.pageNumber);

    if (pages.some((page, index) => page.pageNumber !== index + 1)) {
        throw new Error('Chapter response contained invalid page ordering');
    }

    const images = pages.map(page => page.image);

    if (images.length === 0) throw new Error('Chapter response contained no images');

    return {
        chapterId,
        seriesSlug: slug,
        seriesTitle: seriesTitle,
        seriesApiId: seriesId,
        chapterApiId: numericId,
        images,
    };
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