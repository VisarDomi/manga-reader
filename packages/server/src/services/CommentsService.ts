import { proxyFetchJson } from '../utils/proxyFetch.js';
import type { CacheService } from '../cache/CacheService.js';
import type { ServerMangaProvider } from '../providers/types.js';

const COMMENTS_PAGE_LIMIT = 10;
const COMMENT_REPLY_PAGE_LIMIT = 20;
const COMMENT_TREE_FILL_LIMIT = 40;

export interface CommentsFetchResult {
    data: unknown;
    durationMs: number;
}

interface NormalizedMangaComment {
    id: number;
    parentId: number;
    author: string;
    avatar?: string;
    content: string;
    parts: NormalizedCommentPart[];
    createdAt: string;
    likeCount: number;
    dislikeCount: number;
    replyCount: number;
    shownReplies: number;
    cursor: string;
    replies: NormalizedMangaComment[];
}

type NormalizedCommentPart =
    | { type: 'text'; text: string }
    | { type: 'spoiler'; text: string }
    | { type: 'image'; url: string; alt: string };

interface CommentTreeStats {
    total: number;
    maxDepth: number;
    parents: number;
    missingReplies: number;
    rootPages: number;
    replyPages: number;
    treeFills: number;
    unavailable: number;
    unavailableRoots: number;
}

interface FetchedComments {
    thread: {
        id: number;
        commentCount: number;
        mainCommentCount: number;
        isClosed: boolean;
    };
    comments: NormalizedMangaComment[];
    cursor: string | null;
    pages: number;
    count: number;
    upstreamCount: number;
    stats: CommentTreeStats;
    lookupMs: number;
    commentsMs: number;
}

export class CacheDataUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CacheDataUnavailableError';
    }
}

export class CommentsService {
    constructor(
        private readonly cache: CacheService,
        private readonly provider: ServerMangaProvider,
    ) {}

    async fetchMangaComments(mangaId: string): Promise<CommentsFetchResult> {
        const start = Date.now();
        const raw = this.getCachedMangaDetailRecord(mangaId);
        const numericId = this.numericMangaId(raw, `comments ${mangaId}`);
        const pageUrl = this.provider.mangaPageUrl(mangaId, raw.url);
        const fetched = await this.fetchCommentsForPage(this.provider.mangaCommentIdentifier(numericId), pageUrl, pageUrl, `manga-comments ${mangaId}`);
        console.log(`[comments] manga-comments ${mangaId} thread=${fetched.thread.id} rootPages=${fetched.stats.rootPages} replyPages=${fetched.stats.replyPages} treeFills=${fetched.stats.treeFills} top=${fetched.comments.length} total=${fetched.stats.total} maxDepth=${fetched.stats.maxDepth} parents=${fetched.stats.parents} missingReplies=${fetched.stats.missingReplies} unavailable=${fetched.stats.unavailable} unavailableRoots=${fetched.stats.unavailableRoots} upstreamCount=${fetched.upstreamCount} threadCount=${fetched.thread.commentCount} mainCount=${fetched.thread.mainCommentCount} lookup=${fetched.lookupMs}ms comments=${fetched.commentsMs}ms totalMs=${Date.now() - start}`);
        return { data: this.envelope(fetched), durationMs: Date.now() - start };
    }

    async fetchChapterComments(mangaId: string, chapterId: string, chapterNumber: number, chapterUrl?: string): Promise<CommentsFetchResult> {
        const start = Date.now();
        const raw = this.getCachedMangaDetailRecord(mangaId);
        const numericId = this.numericMangaId(raw, `chapter comments ${mangaId}/${chapterId}`);
        const pageUrl = this.provider.chapterPageUrl(mangaId, chapterId, chapterNumber, chapterUrl);
        const pageIdentifier = this.provider.chapterCommentIdentifier(numericId, chapterNumber);
        const fetched = await this.fetchCommentsForPage(pageIdentifier, pageUrl, pageUrl, `chapter-comments ${mangaId}/${chapterId}`);
        console.log(`[comments] chapter-comments ${mangaId} chapter=${chapterId} number=${chapterNumber} identifier=${pageIdentifier} thread=${fetched.thread.id} rootPages=${fetched.stats.rootPages} replyPages=${fetched.stats.replyPages} treeFills=${fetched.stats.treeFills} top=${fetched.comments.length} total=${fetched.stats.total} maxDepth=${fetched.stats.maxDepth} parents=${fetched.stats.parents} missingReplies=${fetched.stats.missingReplies} unavailable=${fetched.stats.unavailable} unavailableRoots=${fetched.stats.unavailableRoots} upstreamCount=${fetched.upstreamCount} threadCount=${fetched.thread.commentCount} mainCount=${fetched.thread.mainCommentCount} lookup=${fetched.lookupMs}ms comments=${fetched.commentsMs}ms totalMs=${Date.now() - start}`);
        return { data: this.envelope(fetched), durationMs: Date.now() - start };
    }

    private getCachedMangaDetailRecord(mangaId: string): Record<string, unknown> {
        const detail = this.cache.getManga(mangaId);
        if (!detail) {
            this.cache.warmManga(mangaId, 'comments-cache-miss');
            throw new CacheDataUnavailableError(`Manga detail cache is not ready for comments: ${mangaId}`);
        }
        return this.asRecord(this.asRecord(detail)?.result) ?? this.asRecord(detail) ?? {};
    }

    private numericMangaId(raw: Record<string, unknown>, label: string): number {
        const numericId = Number(raw.id);
        if (!Number.isFinite(numericId) || numericId <= 0) {
            throw new Error(`No numeric manga id available for ${label}`);
        }
        return numericId;
    }

    private envelope(fetched: FetchedComments): unknown {
        return {
            status: 'ok',
            result: {
                thread: fetched.thread,
                comments: fetched.comments,
                cursor: fetched.cursor,
                pages: fetched.pages,
                count: fetched.count,
                upstreamCount: fetched.upstreamCount,
                stats: fetched.stats,
            },
        };
    }

    private async fetchCommentsForPage(pageIdentifier: string, pageUrl: string, referer: string, label: string): Promise<FetchedComments> {
        const headers = { Accept: 'application/json', Referer: referer };
        const lookupUrl = this.provider.commentsLookupUrl(pageIdentifier, pageUrl);
        const lookupStart = Date.now();
        const lookup = await proxyFetchJson<Record<string, unknown>>(lookupUrl, {
            headers,
            cloudflareProtected: true,
        });
        const lookupMs = Date.now() - lookupStart;
        const lookupResult = this.asRecord(lookup.data.result) ?? this.asRecord(lookup.data);
        const thread = this.asRecord(lookupResult?.thread);
        const threadId = Number(thread?.id);
        if (!Number.isFinite(threadId) || threadId <= 0) {
            throw new Error(`No comments thread available for ${label}`);
        }

        const commentsBaseUrl = this.provider.commentsPageUrl(threadId);
        const commentsStart = Date.now();
        const rootById = new Map<number, NormalizedMangaComment>();
        let replyPages = 0;
        let treeFills = 0;
        let count = Number.NaN;
        let lastCursor: string | null = null;
        const mainCount = Number(thread?.mainCommentCount ?? 0);

        const newest = await this.loadRootCommentPages(commentsBaseUrl, headers, 'newest', rootById);
        count = newest.upstreamCount;
        lastCursor = newest.cursor;

        let rootPages = newest.pages;
        if (mainCount > 0 && rootById.size < mainCount) {
            const supplement = await this.loadRootCommentPages(commentsBaseUrl, headers, null, rootById);
            rootPages += supplement.pages;
            lastCursor = supplement.cursor ?? lastCursor;
        }

        const rawItems = [...rootById.values()].sort((a, b) => b.id - a.id);
        for (const comment of rawItems) {
            replyPages += await this.loadRemainingReplies(commentsBaseUrl, headers, comment);
        }
        treeFills += await this.fillMissingCommentTrees(headers, rawItems, new Set());

        const commentsMs = Date.now() - commentsStart;
        const comments = this.dedupeComments(rawItems);
        const threadCount = Number(thread?.commentCount ?? 0);
        const stats = this.commentTreeStats(comments, rootPages, replyPages, treeFills, threadCount, mainCount);
        const upstreamCount = Number.isFinite(count) ? count : comments.length;

        return {
            thread: {
                id: Math.floor(threadId),
                commentCount: threadCount,
                mainCommentCount: mainCount,
                isClosed: Boolean(thread?.isClosed),
            },
            comments,
            cursor: lastCursor,
            pages: rootPages,
            count: stats.total,
            upstreamCount,
            stats,
            lookupMs,
            commentsMs,
        };
    }

    private async loadRootCommentPages(
        commentsBaseUrl: string,
        headers: Record<string, string>,
        sort: 'newest' | null,
        rootById: Map<number, NormalizedMangaComment>,
    ): Promise<{ pages: number; cursor: string | null; upstreamCount: number }> {
        let cursor: string | null = null;
        let pages = 0;
        let upstreamCount = Number.NaN;

        while (pages < COMMENTS_PAGE_LIMIT) {
            const params = new URLSearchParams();
            if (sort) params.set('sort', sort);
            if (cursor) params.set('cursor', cursor);
            const comments = await proxyFetchJson<Record<string, unknown>>(`${commentsBaseUrl}?${params}`, {
                headers,
                cloudflareProtected: true,
            });
            const result = this.asRecord(comments.data.result) ?? this.asRecord(comments.data);
            const pageItems = Array.isArray(result?.items) ? result.items : [];
            for (const pageItem of pageItems) {
                const item = this.normalizeComment(pageItem);
                if (item && !rootById.has(item.id)) rootById.set(item.id, item);
            }
            if (!Number.isFinite(upstreamCount)) upstreamCount = Number(result?.count ?? pageItems.length);
            pages++;

            const nextCursor = typeof result?.cursor === 'string' && result.cursor.length > 0 ? result.cursor : null;
            if (!nextCursor || nextCursor === cursor || pageItems.length === 0) break;
            cursor = nextCursor;
        }

        return { pages, cursor, upstreamCount };
    }

    private normalizeComment(value: unknown): NormalizedMangaComment | null {
        const raw = this.asRecord(value);
        if (!raw) return null;
        const id = Number(raw.id);
        if (!Number.isFinite(id) || id <= 0) return null;
        const user = this.asRecord(raw.user) ?? {};
        const repliesRaw = Array.isArray(raw.replies) ? raw.replies : [];
        const replies = repliesRaw
            .map(reply => this.normalizeComment(reply))
            .filter((reply): reply is NormalizedMangaComment => reply != null);
        const parts = this.normalizeCommentParts(raw.contentHtml ?? raw.content);
        return {
            id: Math.floor(id),
            parentId: this.safeNumber(raw.parentId ?? raw.parent_id),
            author: this.firstString(user.displayName, user.username, 'Unknown'),
            ...(typeof user.avatar === 'string' && user.avatar.length > 0 ? { avatar: user.avatar } : {}),
            content: this.partsToText(parts),
            parts,
            createdAt: this.firstString(raw.createdAtFormatted),
            likeCount: this.safeNumber(raw.likeCount),
            dislikeCount: this.safeNumber(raw.dislikeCount),
            replyCount: this.safeNumber(raw.replyCount ?? replies.length),
            shownReplies: this.safeNumber(raw.shownReplies ?? replies.length),
            cursor: this.firstString(raw.cursor),
            replies,
        };
    }

    private async loadRemainingReplies(commentsBaseUrl: string, headers: Record<string, string>, comment: NormalizedMangaComment): Promise<number> {
        let pages = 0;

        for (const reply of comment.replies) {
            pages += await this.loadRemainingReplies(commentsBaseUrl, headers, reply);
        }

        let cursor = comment.cursor || null;
        const seen = new Set(comment.replies.map(reply => reply.id));

        while (cursor && pages < COMMENT_REPLY_PAGE_LIMIT && comment.replies.length < comment.replyCount) {
            const params = new URLSearchParams({
                parent_id: String(comment.id),
                cursor,
            });
            const comments = await proxyFetchJson<Record<string, unknown>>(`${commentsBaseUrl}?${params}`, {
                headers,
                cloudflareProtected: true,
            });
            const result = this.asRecord(comments.data.result) ?? this.asRecord(comments.data);
            const pageItems = Array.isArray(result?.items) ? result.items : [];
            pages++;

            for (const pageItem of pageItems) {
                const reply = this.normalizeComment(pageItem);
                if (!reply || seen.has(reply.id)) continue;
                seen.add(reply.id);
                comment.replies.push(reply);
                pages += await this.loadRemainingReplies(commentsBaseUrl, headers, reply);
            }

            const nextCursor = typeof result?.cursor === 'string' && result.cursor.length > 0 ? result.cursor : null;
            if (!nextCursor || nextCursor === cursor || pageItems.length === 0) break;
            cursor = nextCursor;
            comment.cursor = nextCursor;
            comment.shownReplies = comment.replies.length;
        }

        return pages;
    }

    private async fillMissingCommentTrees(
        headers: Record<string, string>,
        comments: NormalizedMangaComment[],
        seen: Set<number>,
    ): Promise<number> {
        let fills = 0;
        for (const comment of comments) {
            if (seen.has(comment.id)) continue;
            seen.add(comment.id);

            if (comment.replyCount > comment.replies.length && fills < COMMENT_TREE_FILL_LIMIT) {
                const tree = await proxyFetchJson<Record<string, unknown>>(this.provider.commentTreeUrl(comment.id), {
                    headers,
                    cloudflareProtected: true,
                });
                const fresh = this.normalizeComment(this.asRecord(tree.data.result) ?? tree.data);
                fills++;
                if (fresh) this.mergeComment(comment, fresh);
            }

            fills += await this.fillMissingCommentTrees(headers, comment.replies, seen);
        }
        return fills;
    }

    private mergeComment(target: NormalizedMangaComment, source: NormalizedMangaComment): void {
        target.replyCount = Math.max(target.replyCount, source.replyCount);
        target.shownReplies = Math.max(target.shownReplies, source.shownReplies);
        if (source.cursor) target.cursor = source.cursor;

        const byId = new Map(target.replies.map(reply => [reply.id, reply]));
        for (const sourceReply of source.replies) {
            const existing = byId.get(sourceReply.id);
            if (existing) this.mergeComment(existing, sourceReply);
            else {
                target.replies.push(sourceReply);
                byId.set(sourceReply.id, sourceReply);
            }
        }
    }

    private dedupeComments(comments: NormalizedMangaComment[]): NormalizedMangaComment[] {
        const seen = new Set<number>();
        const dedupe = (items: NormalizedMangaComment[]): NormalizedMangaComment[] => {
            const out: NormalizedMangaComment[] = [];
            for (const item of items) {
                if (seen.has(item.id)) continue;
                seen.add(item.id);
                out.push({ ...item, replies: dedupe(item.replies) });
            }
            return out;
        };
        return dedupe(comments);
    }

    private commentTreeStats(
        comments: NormalizedMangaComment[],
        rootPages: number,
        replyPages: number,
        treeFills: number,
        threadCount: number,
        mainCount: number,
    ): CommentTreeStats {
        const stats: CommentTreeStats = {
            total: 0,
            maxDepth: 0,
            parents: 0,
            missingReplies: 0,
            rootPages,
            replyPages,
            treeFills,
            unavailable: 0,
            unavailableRoots: 0,
        };
        const visit = (comment: NormalizedMangaComment, depth: number) => {
            stats.total++;
            stats.maxDepth = Math.max(stats.maxDepth, depth);
            if (comment.replies.length > 0) stats.parents++;
            if (comment.replyCount > comment.shownReplies) {
                stats.missingReplies += comment.replyCount - comment.shownReplies;
            }
            for (const reply of comment.replies) visit(reply, depth + 1);
        };
        for (const comment of comments) visit(comment, 1);
        stats.unavailable = Math.max(0, threadCount - stats.total);
        stats.unavailableRoots = Math.max(0, mainCount - comments.length);
        return stats;
    }

    private normalizeCommentParts(value: unknown): NormalizedCommentPart[] {
        const raw = typeof value === 'string' ? value : '';
        if (!raw) return [];

        const parts: NormalizedCommentPart[] = [];
        const tokenPattern = /<span\b[^>]*class=["'][^"']*\bspoil\b[^"']*["'][^>]*>([\s\S]*?)<\/span>|<img\b[^>]*>/gi;
        let lastIndex = 0;
        let match: RegExpExecArray | null;

        const pushText = (html: string) => {
            const text = this.htmlToText(html);
            if (text) parts.push({ type: 'text', text });
        };

        while ((match = tokenPattern.exec(raw)) != null) {
            pushText(raw.slice(lastIndex, match.index));
            if (match[1] != null) {
                const text = this.htmlToText(match[1]);
                if (text) parts.push({ type: 'spoiler', text });
            } else {
                const img = match[0];
                const src = this.attrValue(img, 'src');
                if (this.isSafeImageUrl(src)) {
                    parts.push({ type: 'image', url: src, alt: this.htmlToText(this.attrValue(img, 'alt')) });
                }
            }
            lastIndex = tokenPattern.lastIndex;
        }

        pushText(raw.slice(lastIndex));
        if (parts.length === 0) {
            const text = this.htmlToText(raw);
            return text ? [{ type: 'text', text }] : [];
        }
        return parts;
    }

    private partsToText(parts: NormalizedCommentPart[]): string {
        return parts
            .map(part => {
                if (part.type === 'image') return part.alt ? `[image: ${part.alt}]` : '[image]';
                return part.text;
            })
            .filter(Boolean)
            .join('\n')
            .trim();
    }

    private htmlToText(value: unknown): string {
        const raw = typeof value === 'string' ? value : '';
        return raw
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]*>/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&#039;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .trim();
    }

    private attrValue(tag: string, name: string): string {
        const pattern = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i');
        const match = tag.match(pattern);
        return match ? this.decodeEntities(match[1]).trim() : '';
    }

    private isSafeImageUrl(url: string): boolean {
        if (!url) return false;
        try {
            const parsed = new URL(url);
            return parsed.protocol === 'https:' || parsed.protocol === 'http:';
        } catch {
            return false;
        }
    }

    private decodeEntities(value: string): string {
        return value
            .replace(/&amp;/g, '&')
            .replace(/&#039;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>');
    }

    private firstString(...values: unknown[]): string {
        for (const value of values) {
            if (typeof value === 'string' && value.length > 0) return value;
            if (typeof value === 'number' && Number.isFinite(value)) return String(value);
        }
        return '';
    }

    private safeNumber(value: unknown): number {
        const num = Number(value ?? 0);
        return Number.isFinite(num) ? num : 0;
    }

    private asRecord(value: unknown): Record<string, unknown> | undefined {
        return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    }
}
