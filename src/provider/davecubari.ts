import type { Provider, RouteMatch, ChapterData, ChapterMeta, ChapterImage } from './types';
import { Handler } from './types';
import { SITE_CONFIG } from '../core/sites';
import { isChapterUnavailable } from '../core/http';

const CUBARI_READER_RE = /^\/read\/gist\/([^/]+)\/([^/]+)\/\d*\/?$/;
const DAVE_LIST_RE = /^\/([^/]+)\/?$/;
const CUBARI_DOMAIN = SITE_CONFIG['cubari'].domain;
const DAVE_DOMAIN = SITE_CONFIG['davemangascans'].domain;

interface CubariSeries {
    title: string;
    cover: string;
    chapters: Record<string, CubariChapter>;
}

interface CubariChapter {
    title?: string;
    groups: Record<string, string>;
}

export const davecubari: Provider = {

    matchRoute(pathname: string): RouteMatch | null {
        // cubari.moe reader URL: /read/gist/<gistId>/<chapter>/<page>/
        const cm = CUBARI_READER_RE.exec(pathname);
        if (cm) return { handler: Handler.Reader, slug: cm[1], chapter: cm[2] };

        // davemangascans.xyz list URL: /<slug> — recognized but no reader action
        if (DAVE_LIST_RE.test(pathname)) return null;

        return null;
    },


    async fetchChapter(slug: string, chapterId: string): Promise<ChapterData | null> {
        // slug = base64 gist ID
        const seriesUrl = `https://${CUBARI_DOMAIN}/read/api/gist/series/${slug}/`;
        const seriesRes = await fetch(seriesUrl);
        if (isChapterUnavailable(seriesRes)) return null;
        const series = await seriesRes.json() as CubariSeries;

        const chapterData = series.chapters[chapterId];
        if (!chapterData) return null;

        // Get the proxy URL for chapter images (use first group)
        const groupKeys = Object.keys(chapterData.groups);
        if (groupKeys.length === 0) return null;
        const proxyPath = chapterData.groups[groupKeys[0]];

        const imgRes = await fetch(`https://${CUBARI_DOMAIN}${proxyPath}`);
        if (isChapterUnavailable(imgRes)) return null;
        const imgUrls = await imgRes.json() as string[];
        if (imgUrls.length === 0) return null;

        const images: ChapterImage[] = imgUrls.map(url => ({
            url,
            width: 0,
            height: 0,
        }));

        return {
            chapterId: chapterId,
            seriesTitle: series.title,
            images,
        };
    },

    async fetchChaptersNewestFirst(slug: string): Promise<ChapterMeta[]> {
        // slug = base64 gist ID
        const url = `https://${CUBARI_DOMAIN}/read/api/gist/series/${slug}/`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Series not found: ${res.status}`);
        const series = await res.json() as CubariSeries;

        // Sort chapters numerically (handle "10.5" style numbers)
        const chapters: ChapterMeta[] = Object.keys(series.chapters)
            .map(ch => ({ chapterId: ch, num: parseFloat(ch) || 0 }))
            .sort((a, b) => b.num - a.num || a.chapterId.localeCompare(b.chapterId))
            .map(({ chapterId: chSlug }) => ({ chapterId: chSlug }));

        return chapters;
    },

    readerUrl(_slug: string, chapterId: string, imgIdx?: string): string {
        const page = imgIdx ? parseInt(imgIdx, 10) + 1 : 1;
        return `https://${CUBARI_DOMAIN}/read/gist/${_slug}/${chapterId}/${page}/`;
    },

    seriesUrl(slug: string): string {
        // slug might be a davemangascans slug or gistId; prefer gist URLs
        if (/^[A-Za-z0-9+/=]{20,}$/.test(slug)) {
            return `https://${CUBARI_DOMAIN}/read/gist/${slug}/`;
        }
        return `https://${DAVE_DOMAIN}/${slug}`;
    },
};
