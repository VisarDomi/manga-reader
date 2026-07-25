import type { Provider, RouteMatch, ChapterData, ChapterMeta, ChapterImage } from './types';
import { SITE_CONFIG } from '../core/sites';
import { isChapterUnavailable } from '../core/http';

const DOMAIN = SITE_CONFIG['valirscans'].domain;
const CHAPTER_RE = /^\/series\/comic\/([^/]+)\/chapter\/(\d+)/;

export const valir: Provider = {

    matchRoute(pathname: string): RouteMatch | null {
        const m = CHAPTER_RE.exec(pathname);
        if (!m) return null;
        return { slug: m[1], chapterId: m[2] };
    },


    async fetchChapter(slug: string, chapterId: string): Promise<ChapterData | null> {
        const pageUrl = `https://${DOMAIN}/series/comic/${slug}/chapter/${chapterId}`;
        const res = await fetch(pageUrl);
        if (isChapterUnavailable(res)) return null;
        const html = await res.text();

        // Extract chapter metadata from the RSC payload
        const chapterMatch = /\\"chaptewr\\":\s*\{[^}]*\\"id\\":\s*\\"([^"\\]+)\\"[^}]*\\"number\\":\s*(\d+)[^}]*\\"title\\":\s*\\"([^"\\]*)\\"/.exec(html);
        if (!chapterMatch) throw new Error('Could not find chapter data in page');

        const numericId = chapterMatch[1]; // cuid2 chapter ID

        // Extract series data
        const seriesMatch = /\\"series\\":\s*\{[^}]*\\"id\\":\s*\\"([^"\\]+)\\"[^}]*\\"title\\":\s*\\"([^"\\]*)\\"/.exec(html);
        if (!seriesMatch) throw new Error('Could not find series data in page');
        const seriesId = seriesMatch[1];
        const seriesTitle = seriesMatch[2];

        // Extract images from the RSC payload first (free chapters have image URLs embedded)
        const images: ChapterImage[] = [];

        // Each page in the RSC payload has: imageUrl, width, height
        const pageDataRe = /\\"imageUrl\\":\s*\\"([^"\\]*)\\"\s*,\s*\\"width\\":\s*(\d+)\s*,\s*\\"height\\":\s*(\d+)/g;
        for (const pageMatch of html.matchAll(pageDataRe)) {
            if (pageMatch[1]) {
                images.push({
                    url: pageMatch[1],
                    width: parseInt(pageMatch[2], 10),
                    height: parseInt(pageMatch[3], 10),
                });
            }
        }

        // If no images found in RSC (premium chapter), try the content API
        if (images.length === 0) {
            const contentRes = await fetch(`https://${DOMAIN}/api/chapters/content?chapterId=${numericId}`, {
                cache: 'no-store',
            });
            if (isChapterUnavailable(contentRes)) return null;
            const contentData = await contentRes.json() as {
                pages?: Array<{
                    imageUrl?: string;
                    pageNumber?: number;
                    width?: number;
                    height?: number;
                    hasStrips?: boolean;
                    strips?: Array<{ imageUrl: string }>;
                    hasFragments?: boolean;
                    fragments?: Array<{ imageUrl: string }>;
                }>;
            };

            const pages = contentData.pages ?? [];
            for (const page of pages) {
                let imageUrl = page.imageUrl;
                if (!imageUrl && page.hasStrips && page.strips?.length) {
                    imageUrl = page.strips[0].imageUrl;
                }
                if (!imageUrl && page.hasFragments && page.fragments?.length) {
                    imageUrl = page.fragments[0].imageUrl;
                }
                if (imageUrl) {
                    images.push({
                        url: imageUrl,
                        width: page.width,
                        height: page.height,
                    });
                }
            }
        }

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

    async trackChapter(data: ChapterData, imageIndex?: string, chaptersNewestFirst?: ChapterMeta[]): Promise<void> {
        if (!data.seriesApiId || !data.chapterApiId || imageIndex === undefined) return;

        const parsedImageIndex = parseInt(imageIndex, 10);
        const totalImages = data.images.length;
        const progress = Math.round((parsedImageIndex + 1) / totalImages * 100);

        const chapters = [{ chapterId: data.chapterApiId, progress }];

        if (chaptersNewestFirst) {
            const currentIdx = chaptersNewestFirst.findIndex(ch => ch.chapterId === data.chapterId);
            if (currentIdx !== -1) {
                for (const ch of chaptersNewestFirst.slice(currentIdx + 1)) {
                    if (ch.chapterApiId) chapters.push({ chapterId: ch.chapterApiId, progress: 100 });
                }
            }
        }

        void fetch(`https://${DOMAIN}/api/chapters/reading-position`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ seriesId: data.seriesApiId, chapters }),
        });
    },
};
