import { Handler, type Provider, type RouteMatch, type ChapterData, type ChapterMeta, type ChapterImage } from './types';
import { SITE_CONFIG } from '../core/sites';
import { isChapterUnavailable } from '../core/http';
import { hashImageIndex } from '../core/page';

const CHAPTER_RE = /^\/comics\/([^/]+)\/chapter\/(\d+)/;
const DOMAIN = SITE_CONFIG['asurascans'].domain;
const API_BASE = SITE_CONFIG['asurascans'].apiBase!;
const ASURA_STYLESHEET_PATH = /^\/_astro\/[^/]+\.css$/;

function ruleCount(link: HTMLLinkElement): number | null {
    try {
        return link.sheet?.cssRules.length ?? null;
    } catch {
        return null;
    }
}

function isAsuraStylesheet(link: HTMLLinkElement): boolean {
    if (link.rel !== 'stylesheet' || link.dataset.mangaReaderRepair !== undefined) return false;
    return ASURA_STYLESHEET_PATH.test(new URL(link.href, location.href).pathname);
}

function repairStylesheet(link: HTMLLinkElement): void {
    if (document.querySelector('link[data-manga-reader-repair]')) return;

    const replacement = document.createElement('link');
    replacement.rel = 'stylesheet';
    replacement.dataset.mangaReaderRepair = '';

    const url = new URL(link.href);
    url.searchParams.set('manga-reader-cache-bust', String(Date.now()));
    replacement.href = url.href;

    replacement.addEventListener('load', () => {
        if ((ruleCount(replacement) ?? 0) > 0) link.remove();
        else replacement.remove();
    }, { once: true });
    replacement.addEventListener('error', () => replacement.remove(), { once: true });
    document.head.appendChild(replacement);
}

function watchStylesheet(link: HTMLLinkElement): void {
    if (!isAsuraStylesheet(link)) return;

    const repairIfEmpty = () => {
        if (ruleCount(link) === 0) repairStylesheet(link);
    };
    if (link.sheet) repairIfEmpty();
    else link.addEventListener('load', repairIfEmpty, { once: true });
}

function openAsuraHome(): void {
    document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]').forEach(watchStylesheet);

    const observer = new MutationObserver(records => {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node instanceof HTMLLinkElement) watchStylesheet(node);
                else if (node instanceof Element) {
                    node.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]').forEach(watchStylesheet);
                }
            }
        }
    });
    observer.observe(document, { childList: true, subtree: true });

    window.addEventListener('pageshow', () => {
        document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]').forEach(watchStylesheet);
    });
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

    matchRoute(pathname: string, hash: string): RouteMatch | null {
        if (pathname === '/') return { handler: Handler.Home };
        const m = CHAPTER_RE.exec(pathname);
        if (!m) return null;
        return { handler: Handler.Reader, slug: m[1], chapterId: m[2], imageIndex: hashImageIndex(hash) };
    },

    openHome: openAsuraHome,

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
        const token = globalThis.localStorage?.getItem('access_token');
        if (!token) return;
        const headers = {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        };
        void fetch(`${API_BASE}/bookmarks/${data.seriesApiId}/read/${data.chapterId}`, { method: 'POST', headers })
        void fetch(`${API_BASE}/views/chapter`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ chapter_id: data.chapterApiId, series_id: data.seriesApiId }),
        })
    },
};
