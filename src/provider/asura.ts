import { Handler, type Provider, type RouteMatch, type ChapterData, type ChapterMeta, type ChapterImage } from './types';
import { SITE_CONFIG } from '../core/sites';
import { isChapterUnavailable } from '../core/http';
import { hashImageIndex } from '../core/page';
import { createAsuraTokenManager } from './asura-token-manager';

const CHAPTER_RE = /^\/comics\/([^/]+)\/chapter\/(\d+)/;
const SERIES_PATH_RE = /^\/comics\/([^/]+)$/;
const DOMAIN = SITE_CONFIG['asurascans'].domain;
const API_BASE = SITE_CONFIG['asurascans'].apiBase!;
export const asuraTokenManager = createAsuraTokenManager(API_BASE);

export interface AsuraHomeChapter {
    chapterId: string;
    chapterNumber: number;
    label: string;
    uploadedAt: string;
    locked: boolean;
    read: boolean;
    unlockAt: string | null;
}

export interface AsuraHomeSeries {
    slug: string;
    historySlug: string;
    title: string;
    coverUrl: string;
    chapters: AsuraHomeChapter[];
}

export interface AsuraHomeData {
    title: string;
    series: AsuraHomeSeries[];
}

interface EncodedChapter {
    chapterId: string;
    chapterNumber: number;
    seriesName: string;
    historySlug: string;
    publicSlug: string;
    coverUrl: string;
    publishedAt: string;
    uploadedAt: string;
    locked: boolean;
    unlockAt: string | null;
    pinned: boolean;
}

function requiredAttribute(element: Element, name: string): string {
    const value = element.getAttribute(name);
    if (value === null) throw new Error(`Asura home element is missing ${name}`);
    return value;
}

function requiredText(value: string | null, context: string): string {
    if (value === null) throw new Error(`Asura home is missing ${context}`);
    const text = value.replace(/\s+/g, ' ').trim();
    if (text.length === 0) throw new Error(`Asura home has empty ${context}`);
    return text;
}

function requiredRecord(value: unknown, context: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`Asura ${context} is not an object`);
    }
    return Object.fromEntries(Object.entries(value));
}

function taggedPayload(value: unknown, tag: number, context: string): unknown {
    if (!Array.isArray(value) || value.length !== 2 || value[0] !== tag) {
        throw new Error(`Asura ${context} has an invalid serialization tag`);
    }
    return value[1];
}

function encodedField(record: Record<string, unknown>, key: string, context: string): unknown {
    if (!(key in record)) throw new Error(`Asura ${context} is missing ${key}`);
    const encoded = record[key];
    if (!Array.isArray(encoded) || encoded[0] !== 0 || encoded.length > 2) {
        throw new Error(`Asura ${context}.${key} is not a serialized primitive`);
    }
    return encoded[1];
}

function optionalEncodedField(record: Record<string, unknown>, key: string, context: string): unknown {
    if (!(key in record)) return undefined;
    return encodedField(record, key, context);
}

function requiredStringField(record: Record<string, unknown>, key: string, context: string): string {
    const value = encodedField(record, key, context);
    if (typeof value !== 'string') throw new Error(`Asura ${context}.${key} is not a string`);
    return requiredText(value, `${context}.${key}`);
}

function requiredNumberField(record: Record<string, unknown>, key: string, context: string): number {
    const value = encodedField(record, key, context);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Asura ${context}.${key} is not a number`);
    }
    return value;
}

function requiredBooleanField(record: Record<string, unknown>, key: string, context: string): boolean {
    const value = encodedField(record, key, context);
    if (typeof value !== 'boolean') throw new Error(`Asura ${context}.${key} is not a boolean`);
    return value;
}

function optionalStringField(record: Record<string, unknown>, key: string, context: string): string | null {
    const value = optionalEncodedField(record, key, context);
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw new Error(`Asura ${context}.${key} is not a string`);
    return requiredText(value, `${context}.${key}`);
}

function optionalBooleanField(record: Record<string, unknown>, key: string, context: string): boolean | undefined {
    const value = optionalEncodedField(record, key, context);
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') throw new Error(`Asura ${context}.${key} is not a boolean`);
    return value;
}

function optimizedCoverUrl(rawUrl: string, baseUrl: URL): string {
    const url = new URL(rawUrl, baseUrl);
    if (url.pathname.includes('/covers/') && url.pathname.endsWith('.webp')) {
        url.pathname = `${url.pathname.slice(0, -5)}-400.webp`;
    }
    return url.href;
}

function parseDate(value: string, context: string): number {
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) throw new Error(`Asura ${context} is not a date`);
    return timestamp;
}

function parsePublicSlug(publicUrl: string, baseUrl: URL, context: string): string {
    const pathname = new URL(publicUrl, baseUrl).pathname;
    const match = SERIES_PATH_RE.exec(pathname);
    if (!match) throw new Error(`Invalid Asura ${context} series URL: ${pathname}`);
    return match[1];
}

function parseEncodedChapter(value: unknown, index: number, baseUrl: URL, now: number): EncodedChapter {
    const context = `home chapter ${index}`;
    const record = requiredRecord(taggedPayload(value, 0, context), context);
    const chapterId = requiredStringField(record, 'name', context);
    const chapterNumber = requiredNumberField(record, 'number', context);
    const publishedAt = requiredStringField(record, 'published_at', context);
    parseDate(publishedAt, `${context}.published_at`);
    const unlockAt = optionalStringField(record, 'early_access_until', context);
    const explicitLock = optionalBooleanField(record, 'is_locked', context);
    const isPremium = requiredBooleanField(record, 'is_premium', context);
    let locked = isPremium;
    if (unlockAt !== null) locked = parseDate(unlockAt, `${context}.early_access_until`) > now;
    if (explicitLock !== undefined) locked = explicitLock;

    return {
        chapterId,
        chapterNumber,
        seriesName: requiredStringField(record, 'comic_name', context),
        historySlug: requiredStringField(record, 'comic_slug', context),
        publicSlug: parsePublicSlug(requiredStringField(record, 'comic_public_url', context), baseUrl, context),
        coverUrl: optimizedCoverUrl(requiredStringField(record, 'comic_cover', context), baseUrl),
        publishedAt,
        uploadedAt: requiredStringField(record, 'time_ago', context),
        locked,
        unlockAt,
        pinned: optionalBooleanField(record, 'is_pinned', context) === true,
    };
}

function parseHighestReadChapter(value: unknown, historySlug: string): number {
    const values = Array.isArray(value) ? value : [value];
    if (values.length === 0) throw new Error(`Asura read history for ${historySlug} is empty`);
    const numbers = values.map(item => {
        if (typeof item !== 'number' && typeof item !== 'string') {
            throw new Error(`Asura read history for ${historySlug} contains a non-number`);
        }
        const chapterNumber = Number(item);
        if (!Number.isFinite(chapterNumber)) {
            throw new Error(`Asura read history for ${historySlug} contains an invalid number`);
        }
        return chapterNumber;
    });
    return Math.max(...numbers);
}

export async function fetchAsuraReadHistory(): Promise<Map<string, number>> {
    if (!asuraTokenManager.hasSession()) return new Map();

    const res = await asuraTokenManager.fetch(`${API_BASE}/me/read-chapters`);
    if (!res.ok) throw new Error(`Asura read history failed: ${res.status}`);
    const response = requiredRecord(await res.json(), 'read history response');
    if (!('data' in response)) throw new Error('Asura read history response is missing data');
    const data = requiredRecord(response.data, 'read history data');
    return new Map(Object.entries(data).map(([historySlug, value]) => [
        historySlug,
        parseHighestReadChapter(value, historySlug),
    ]));
}

function parseHomeSeries(doc: Document, baseUrl: URL): AsuraHomeSeries[] {
    const island = doc.querySelector<HTMLElement>('astro-island[component-url*="/LatestUpdates."]');
    if (!island) throw new Error('Asura home is missing Latest Updates data');
    const props = requiredRecord(JSON.parse(requiredAttribute(island, 'props')), 'Latest Updates props');
    const encodedChapters = taggedPayload(props.chapters, 1, 'Latest Updates chapters');
    if (!Array.isArray(encodedChapters) || encodedChapters.length === 0) {
        throw new Error('Asura home contains no Latest Updates chapters');
    }

    const now = Date.now();
    const chapters = encodedChapters.map((value, index) => parseEncodedChapter(value, index, baseUrl, now));
    const groups = new Map<string, {
        series: AsuraHomeSeries;
        historySlug: string;
        pinned: boolean;
        latestPublishedAt: number;
        chapterNumbers: Set<number>;
    }>();

    for (const chapter of chapters) {
        let group = groups.get(chapter.historySlug);
        if (!group) {
            group = {
                series: {
                    slug: chapter.publicSlug,
                    historySlug: chapter.historySlug,
                    title: chapter.seriesName,
                    coverUrl: chapter.coverUrl,
                    chapters: [],
                },
                historySlug: chapter.historySlug,
                pinned: chapter.pinned,
                latestPublishedAt: parseDate(chapter.publishedAt, `${chapter.historySlug} published_at`),
                chapterNumbers: new Set(),
            };
            groups.set(chapter.historySlug, group);
        } else if (
            group.series.slug !== chapter.publicSlug ||
            group.series.title !== chapter.seriesName ||
            group.series.coverUrl !== chapter.coverUrl ||
            group.pinned !== chapter.pinned
        ) {
            throw new Error(`Asura home series ${chapter.historySlug} has inconsistent metadata`);
        }
        if (group.chapterNumbers.has(chapter.chapterNumber)) {
            throw new Error(`Asura home series ${chapter.historySlug} repeats chapter ${chapter.chapterNumber}`);
        }
        group.chapterNumbers.add(chapter.chapterNumber);
        group.series.chapters.push({
            chapterId: chapter.chapterId,
            chapterNumber: chapter.chapterNumber,
            label: `Chapter ${chapter.chapterId}`,
            uploadedAt: chapter.uploadedAt,
            locked: chapter.locked,
            read: false,
            unlockAt: chapter.unlockAt,
        });
    }

    for (const group of groups.values()) {
        if (group.series.chapters.length !== 3) {
            throw new Error(`Asura home series ${group.historySlug} has ${group.series.chapters.length} chapters`);
        }
    }

    return [...groups.values()]
        .sort((left, right) => {
            if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
            return right.latestPublishedAt - left.latestPublishedAt;
        })
        .map(group => group.series);
}

export async function fetchAsuraHome(): Promise<AsuraHomeData> {
    const pageUrl = new URL(`https://${DOMAIN}/`);
    const res = await fetch(pageUrl);
    if (!res.ok) throw new Error(`Home page failed: ${res.status}`);
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');

    return {
        title: 'Latest Updates',
        series: parseHomeSeries(doc, pageUrl),
    };
}

interface AsuraPage {
    url: string;
    width: number;
    height: number;
}

interface AsuraChapterResponse {
    chapter: {
        id: number;
        series_id: number;
        number: number;
        pages: AsuraPage[];
    };
    series: {
        id: number;
        title: string;
        cover: string;
    };
    prev_chapter: { number: number } | null;
    next_chapter: { number: number } | null;
    is_locked: boolean;
}

export const asura: Provider = {
    tokenManager: asuraTokenManager,

    matchRoute(pathname: string, hash: string): RouteMatch | null {
        if (pathname === '/') return { handler: Handler.Home };
        const m = CHAPTER_RE.exec(pathname);
        if (!m) return null;
        return { handler: Handler.Reader, slug: m[1], chapterId: m[2], imageIndex: hashImageIndex(hash) };
    },

    async fetchChapter(slug: string, chapterId: string): Promise<ChapterData | null> {
        const res = await fetch(`${API_BASE}/series/${slug}/chapters/${chapterId}`);
        if (isChapterUnavailable(res)) return null;
        const json = await res.json() as { data: AsuraChapterResponse };
        const data = json.data;

        if (data.is_locked) return null;

        const pages = data.chapter.pages;
        const images: ChapterImage[] = pages.map(p => ({
            url: p.url,
            width: p.width,
            height: p.height,
        }));

        return {
            chapterId,
            seriesTitle: data.series.title,
            seriesApiId: data.series.id,
            chapterApiId: data.chapter.id,
            images,
        };
    },

    async fetchChaptersNewestFirst(slug: string): Promise<ChapterMeta[]> {
        const res = await fetch(`${API_BASE}/series/${slug}/chapters`);
        if (!res.ok) throw new Error(`Chapter list failed: ${res.status}`);
        const json = await res.json() as { data: Array<{ number: number }> };
        return (json.data).map(ch => ({ chapterId: String(ch.number) }));
    },

    readerUrl(_slug: string, chapterId: string, imageIndex?: string): string {
        return `https://${DOMAIN}/comics/${_slug}/chapter/${chapterId}${imageIndex ? `#${imageIndex}` : ''}`;
    },

    seriesUrl(slug: string): string {
        return `https://${DOMAIN}/comics/${slug}`;
    },

    async trackChapter(data: ChapterData): Promise<void> {
        if (!data.seriesApiId || !data.chapterApiId) return;
        if (!asuraTokenManager.hasSession()) return;
        const headers = {
            'Content-Type': 'application/json',
        };
        const responses = await Promise.all([
            asuraTokenManager.fetch(`${API_BASE}/bookmarks/${data.seriesApiId}/read/${data.chapterId}`, {
                method: 'POST',
                headers,
            }),
            asuraTokenManager.fetch(`${API_BASE}/views/chapter`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ chapter_id: data.chapterApiId, series_id: data.seriesApiId }),
            }),
        ]);
        for (const response of responses) {
            if (!response.ok) throw new Error(`Asura chapter tracking failed: ${response.status}`);
        }
    },
};
