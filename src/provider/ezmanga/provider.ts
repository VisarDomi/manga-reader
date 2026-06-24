import type { Provider, RouteMatch, ChapterData, MangaComment, EzComment, CommentsResponse } from '../types';
import { Handler } from '../types';

const CHAPTER_RE = /^\/series\/([^/]+)\/chapter-(\d+)/;
const API_BASE = 'https://vapi.ezmanga.org/api/v1';

export const provider: Provider = {
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

    async fetchComments(data: ChapterData): Promise<MangaComment[]> {
        const rootResponse = await fetch(`${API_BASE}/chapters/${data.id!}/comments`);
        if (!rootResponse.ok) throw new Error(`Comments fetch failed: ${rootResponse.status}`);
        const rootData = await rootResponse.json() as CommentsResponse;

        const allEz: EzComment[] = [...rootData.data];

        for (const root of rootData.data) {
            if (root.replyCount > 0) {
                await fetchRepliesRecursive(root.id, allEz);
            }
        }

        return buildCommentTree(allEz);
    },

    seriesUrl(slug: string): string {
        return `https://ezmanga.org/series/${slug}`;
    },
};

async function fetchRepliesRecursive(commentId: number, allEz: EzComment[]): Promise<void> {
    const res = await fetch(`${API_BASE}/comments/${commentId}/replies`);
    if (!res.ok) throw new Error(`Replies fetch failed: ${res.status}`);
    const data = await res.json() as CommentsResponse;
    allEz.push(...data.data);

    for (const reply of data.data) {
        if (reply.replyCount > 0) {
            await fetchRepliesRecursive(reply.id, allEz);
        }
    }
}

function buildCommentTree(ezComments: EzComment[]): MangaComment[] {
    const map = new Map<number, MangaComment>();
    const roots: MangaComment[] = [];

    for (const ez of ezComments) {
        map.set(ez.id, {
            id: ez.id,
            author: ez.author.displayName,
            avatar: ez.author.avatar || null,
            content: ez.content,
            createdAt: ez.createdAt,
            score: ez.score,
            replies: [],
        });
    }

    for (const ez of ezComments) {
        const child = map.get(ez.id);
        if (!child) continue;
        if (ez.parentId != null) {
            const parent = map.get(ez.parentId);
            if (parent) parent.replies.push(child);
        } else {
            roots.push(child);
        }
    }

    return roots;
}
