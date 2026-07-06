import type { Provider, RouteMatch, ChapterData } from './types';
import { Handler } from './types';

const CHAPTER_RE = /^\/series\/([^/]+)\/chapter-(\d+)/;
const API_BASE = 'https://vapi.ezmanga.org/api/v1';

export const ezmanga: Provider = {
    name: 'ezmanga',

    matchRoute(pathname: string): RouteMatch | null {
        const m = CHAPTER_RE.exec(pathname);
        if (!m) return null;
        return { handler: Handler.Reader, slug: m[1], chapter: parseInt(m[2]) };
    },

    async init(): Promise<void> {
        // no-op
    },

    async fetchChapter(slug: string, chapter: number): Promise<ChapterData> {
        const res = await fetch(`${API_BASE}/series/${slug}/chapters/chapter-${chapter}`);
        if (!res.ok) throw new Error(`Chapter not found: ${res.status}`);
        const data = await res.json() as ChapterData;
        if (!data.isFree || data.requiresPurchase) throw new Error('Chapter is paid');

        const prev = chapter > 1 ? `https://ezmanga.org/series/${slug}/chapter-${chapter - 1}` : null;
        const next = `https://ezmanga.org/series/${slug}/chapter-${chapter + 1}`;

        return { ...data, prevUrl: prev, nextUrl: next };
    },

    seriesUrl(slug: string): string {
        return `https://ezmanga.org/series/${slug}`;
    },
};
