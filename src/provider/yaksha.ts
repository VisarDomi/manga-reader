import type { Provider, RouteMatch, ChapterData, ChapterImage } from './types';
import { Handler } from './types';

const CHAPTER_RE = /^\/manga\/([^/]+)\/chapter-(\d+)/;
const DOMAIN = 'yakshacomics.com';

export const yaksha: Provider = {
    name: 'yaksha',

    matchRoute(pathname: string): RouteMatch | null {
        const m = CHAPTER_RE.exec(pathname);
        if (!m) return null;
        return { handler: Handler.Reader, slug: m[1], chapter: parseInt(m[2]) };
    },

    async init(): Promise<void> {
        // no-op
    },

    async fetchChapter(slug: string, chapter: number): Promise<ChapterData> {
        const url = chapterUrl(slug, chapter);
        const res = await fetch(url);
        if (res.redirected || !res.ok) throw new Error('Chapter not found');
        const html = await res.text();

        // Scrape image URLs (attribute order varies: src may appear before or after class)
        const srcs: string[] = [];
        const imgTagRe = /<img\b[^>]*\bclass="wp-manga-chapter-img"[^>]*>/g;
        let tagMatch;
        while ((tagMatch = imgTagRe.exec(html)) !== null) {
            const srcMatch = /src="([^"]+)"/.exec(tagMatch[0]);
            if (srcMatch) srcs.push(srcMatch[1].trim().replace(/\s+/g, ''));
        }

        if (srcs.length === 0) throw new Error('Chapter not found');

        // Fetch dimensions in parallel from binary headers
        const dimResults = await Promise.all(srcs.map(getImageDimensions));
        const images: ChapterImage[] = srcs.map((src, i) => {
            const dim = dimResults[i];
            return { url: src, order: i, width: dim?.width ?? 0, height: dim?.height ?? 0 };
        });

        // Series title from breadcrumbs (scoped to breadcrumb block)
        const bcMatch = /<ol class="breadcrumb">[\s\S]*?<a[^>]*href="[^"]*\/manga\/[^/]+\/"[^>]*>([^<]+)<\/a>/.exec(html);
        const seriesTitle = bcMatch ? bcMatch[1].trim() : '';

        const prev = chapter > 1 ? chapterUrl(slug, chapter - 1) : null;
        const next = chapterUrl(slug, chapter + 1);

        return {
            slug,
            number: chapter,
            title: null,
            content: null,
            cover: '',
            publishStatus: 'PUBLIC',
            price: 0,
            isFree: true,
            requiresPurchase: false,
            series: { title: seriesTitle },
            images,
            prevUrl: prev,
            nextUrl: next,
        };
    },

    seriesUrl(slug: string): string {
        return `https://${DOMAIN}/manga/${slug}/`;
    },
};

function chapterUrl(slug: string, chapter: number): string {
    return `https://${DOMAIN}/manga/${slug}/chapter-${chapter}/`;
}

// ── Image dimension parsing from binary headers ─────────────────────────

async function getImageDimensions(url: string): Promise<{ width: number; height: number } | null> {
    try {
        const res = await fetch(url, { headers: { 'Range': 'bytes=0-2047' } });
        const buffer = new Uint8Array(await res.arrayBuffer());

        // JPEG: FF C0 / FF C2
        for (let i = 0; i < buffer.length - 9; i++) {
            if (buffer[i] === 0xFF && (buffer[i + 1] === 0xC0 || buffer[i + 1] === 0xC2)) {
                return {
                    width: (buffer[i + 7] << 8) | buffer[i + 8],
                    height: (buffer[i + 5] << 8) | buffer[i + 6],
                };
            }
        }

        // PNG
        if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
            return {
                width: (buffer[16] << 24) | (buffer[17] << 16) | (buffer[18] << 8) | buffer[19],
                height: (buffer[20] << 24) | (buffer[21] << 16) | (buffer[22] << 8) | buffer[23],
            };
        }

        // WebP
        if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
            buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
            const chunk = String.fromCharCode(buffer[12], buffer[13], buffer[14], buffer[15]);
            if (chunk === 'VP8X') {
                return {
                    width: (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1,
                    height: (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1,
                };
            }
            if (chunk === 'VP8L' && buffer.length > 24) {
                const bits = buffer[21] | (buffer[22] << 8) | (buffer[23] << 16) | (buffer[24] << 24);
                return { width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 };
            }
        }
    } catch {
        // ignore
    }
    return null;
}
