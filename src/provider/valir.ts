import { Handler, type Provider, type RouteMatch, type ChapterData, type ChapterMeta, type ChapterImage } from './types';
import { SITE_CONFIG } from '../core/sites';
import { isChapterUnavailable } from '../core/http';
import { hashImageIndex } from '../core/page';
import { createValirTokenManager } from './valir-token-manager';

const DOMAIN = SITE_CONFIG['valirscans'].domain;
const CHAPTER_RE = /^\/series\/comic\/([^/]+)\/chapter\/(\d+)/;
export const valirTokenManager = createValirTokenManager(`https://${DOMAIN}`);

export const valir: Provider = {
    tokenManager: valirTokenManager,

    matchRoute(pathname: string, hash: string): RouteMatch | null {
        const m = CHAPTER_RE.exec(pathname);
        if (!m) return null;
        return { handler: Handler.Reader, slug: m[1], chapterId: m[2], imageIndex: hashImageIndex(hash) };
    },


    async fetchChapter(slug: string, chapterId: string): Promise<ChapterData | null> {
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
            seriesTitle: seriesTitle,
            seriesApiId: seriesId,
            chapterApiId: numericId,
            images,
        };
    },

    async fetchChaptersNewestFirst(slug: string): Promise<ChapterMeta[]> {
        // Fetch the first chapter page — it contains the allChapters array for this series
        const pageUrl = `https://${DOMAIN}/series/comic/${slug}/chapter/1`;
        const res = await fetch(pageUrl);
        if (!res.ok) throw new Error(`Chapter page not found: ${res.status}`);
        const html = await res.text();

        // Find the allChapters section and extract chapter numbers from it
        const acIdx = html.indexOf('allChapters');
        if (acIdx === -1) throw new Error('No chapter list found');

        // Look at the region after allChapters for chapter entries
        const region = html.substring(acIdx, acIdx + 100000);
        const chapters: ChapterMeta[] = [];
        const chapterRe = /\\"id\\":\s*\\"(cm[a-z0-9]+)\\",\s*\\"number\\":\s*(\d+),\s*\\"title\\":\s*\\"Chapter (\d+)\\"/g;
        const seen = new Set<number>();
        for (const m of region.matchAll(chapterRe)) {
            const num = parseInt(m[2], 10);
            if (!seen.has(num)) {
                seen.add(num);
                chapters.push({ chapterId: String(num), chapterApiId: m[1] });
            }
        }

        if (chapters.length === 0) throw new Error('No chapters found');

        return chapters.reverse();
    },

    readerUrl(slug: string, chapterId: string, imageIndex?: string): string {
        return `https://${DOMAIN}/series/comic/${slug}/chapter/${chapterId}${imageIndex ? `#${imageIndex}` : ''}`;
    },

    seriesUrl(slug: string): string {
        return `https://${DOMAIN}/series/comic/${slug}`;
    },

    async trackPage(data: ChapterData, imageIndex: string, chaptersNewestFirst: ChapterMeta[]): Promise<void> {
        if (!data.seriesApiId || !data.chapterApiId) return;

        const parsedImageIndex = parseInt(imageIndex, 10);
        const totalImages = data.images.length;
        const progress = Math.round((parsedImageIndex + 1) / totalImages * 100);

        const chapters = [{ chapterId: data.chapterApiId, progress }];

        const currentIdx = chaptersNewestFirst.findIndex(ch => ch.chapterId === data.chapterId);
        if (currentIdx !== -1) {
            for (const ch of chaptersNewestFirst.slice(currentIdx + 1)) {
                if (ch.chapterApiId) chapters.push({ chapterId: ch.chapterApiId, progress: 100 });
            }
        }

        const response = await valirTokenManager.fetch(`https://${DOMAIN}/api/chapters/reading-position`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ seriesId: data.seriesApiId, chapters }),
        });
        if (response !== null && !response.ok) {
            throw new Error(`Valir reading position failed: ${response.status}`);
        }
    },
};
