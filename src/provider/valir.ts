import type { Provider, RouteMatch, ChapterData, ChapterMeta, ChapterImage } from './types';
import { Handler } from './types';
import { SITE_CONFIG } from '../sites';

const DOMAIN = SITE_CONFIG['valirscans'].domain;
const CHAPTER_RE = /^\/series\/comic\/([^/]+)\/chapter\/(\d+)/;

export const valir: Provider = {

    matchRoute(pathname: string): RouteMatch | null {
        const m = CHAPTER_RE.exec(pathname);
        if (!m) return null;
        return { handler: Handler.Reader, slug: m[1], chapter: m[2] };
    },

    async init(): Promise<void> { /* no-op */ },

    async fetchChapter(slug: string, chapterId: string): Promise<ChapterData> {
        const pageUrl = `https://${DOMAIN}/series/comic/${slug}/chapter/${chapterId}`;
        const res = await fetch(pageUrl);
        if (!res.ok) throw new Error(`Chapter page not found: ${res.status}`);
        const html = await res.text();

        // Extract chapter metadata from the RSC payload
        const chapterMatch = /\\"chapter\\":\s*\{[^}]*\\"id\\":\s*\\"([^"\\]+)\\"[^}]*\\"number\\":\s*(\d+)[^}]*\\"title\\":\s*\\"([^"\\]*)\\"/.exec(html);
        if (!chapterMatch) throw new Error('Could not find chapter data in page');

        const numericId = chapterMatch[1]; // cuid2 chapter ID
        const chapterNumber = parseInt(chapterMatch[2], 10);
        const chapterTitle = chapterMatch[3];

        // Extract series data
        const seriesMatch = /\\"series\\":\s*\{[^}]*\\"id\\":\s*\\"([^"\\]+)\\"[^}]*\\"title\\":\s*\\"([^"\\]*)\\"[^}]*\\"coverImage\\":\s*\\"([^"\\]*)\\"/.exec(html);
        const seriesTitle = seriesMatch?.[2] ?? '';
        const coverImage = seriesMatch?.[3] ?? '';

        // Extract navigation
        const prevMatch = /\\"prevChapter\\":\s*(\d+)/.exec(html);
        const nextMatch = /\\"nextChapter\\":\s*(\d+|null)/.exec(html);
        const prevChapter = prevMatch ? parseInt(prevMatch[1], 10) : null;
        const nextChapterRaw = nextMatch?.[1];
        const nextChapter = nextChapterRaw && nextChapterRaw !== 'null' ? parseInt(nextChapterRaw, 10) : null;

        // Extract images from the RSC payload first (free chapters have image URLs embedded)
        const images: ChapterImage[] = [];

        // Each page in the RSC payload has: imageUrl, width, height
        const pageDataRe = /\\"imageUrl\\":\s*\\"([^"\\]*)\\"\s*,\s*\\"width\\":\s*(\d+)\s*,\s*\\"height\\":\s*(\d+)/g;
        let pageMatch;
        let order = 0;
        while ((pageMatch = pageDataRe.exec(html)) !== null) {
            if (pageMatch[1]) {
                images.push({
                    url: pageMatch[1],
                    order: order,
                    width: parseInt(pageMatch[2], 10),
                    height: parseInt(pageMatch[3], 10),
                });
                order++;
            }
        }

        // If no images found in RSC (premium chapter), try the content API
        if (images.length === 0) {
            const contentRes = await fetch(`https://${DOMAIN}/api/chapters/content?chapterId=${numericId}`, {
                cache: 'no-store',
            });
            if (!contentRes.ok) throw new Error(`Chapter requires authentication: ${contentRes.status}`);
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
            for (let i = 0; i < pages.length; i++) {
                const page = pages[i];
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
                        order: page.pageNumber ?? i,
                        width: page.width ?? 0,
                        height: page.height ?? 0,
                    });
                }
            }
        }

        if (images.length === 0) throw new Error('No images found for this chapter');

        return {
            slug,
            number: chapterNumber,
            title: chapterTitle || null,
            content: null,
            cover: coverImage ? `https://${DOMAIN}${coverImage}` : '',
            publishStatus: 'PUBLIC',
            price: 0,
            isFree: true,
            requiresPurchase: false,
            series: { title: seriesTitle },
            images,
            prevUrl: prevChapter ? `/series/comic/${slug}/chapter/${prevChapter}` : null,
            nextUrl: nextChapter ? `/series/comic/${slug}/chapter/${nextChapter}` : null,
        };
    },

    async fetchChapterList(slug: string): Promise<ChapterMeta[]> {
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
        let m;
        const seen = new Set<number>();
        while ((m = chapterRe.exec(region)) !== null) {
            const num = parseInt(m[2], 10);
            if (!seen.has(num)) {
                seen.add(num);
                chapters.push({ slug: String(num) });
            }
        }

        if (chapters.length === 0) throw new Error('No chapters found');

        chapters.sort((a, b) => {
            return parseInt(a.slug, 10) - parseInt(b.slug, 10);
        });

        return chapters;
    },

    readerUrl(slug: string, chapterId: string, imgIdx?: string): string {
        return `https://${DOMAIN}/series/comic/${slug}/chapter/${chapterId}${imgIdx ? `#${imgIdx}` : ''}`;
    },

    seriesUrl(slug: string): string {
        return `https://${DOMAIN}/series/comic/${slug}`;
    },

    getNextChapter(chapterList: ChapterMeta[], lastChapter: string): ChapterMeta {
        const idx = chapterList.findIndex(m => m.slug === lastChapter);
        return chapterList[idx + 1];
    },
};
