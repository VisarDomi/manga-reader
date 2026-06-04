import { CloudflareError, UpstreamError, proxyFetchJson } from '../utils/proxyFetch.js';
import type { CacheService } from '../cache/CacheService.js';
import type { ServerMangaProvider } from '../providers/types.js';
import type { BrowserFetchContext, BrowserSession } from './BrowserSession.js';

const COMMENTS_MIN_ROOT_PAGE_BUDGET = 10;
const COMMENTS_PAGE_TIMEOUT_MS = 30_000;
const COMMENTS_PAGE_ATTEMPTS = 3;
const COMMENTS_RETRY_DELAY_MS = 350;

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
        private readonly browserSession?: BrowserSession,
    ) {}

    async fetchMangaComments(mangaId: string): Promise<CommentsFetchResult> {
        const start = Date.now();
        const raw = await this.getCachedMangaDetailRecord(mangaId);
        const numericId = this.numericMangaId(raw, `comments ${mangaId}`);
        const pageUrl = this.provider.mangaPageUrl(mangaId, raw.url);
        const directUrl = this.provider.mangaCommentsUrl?.(numericId, pageUrl) ?? null;
        if (directUrl) {
            const fetched = await this.fetchDirectComments(directUrl, pageUrl, `manga-comments ${mangaId}`);
            console.log(`[comments] manga-comments ${mangaId} mode=direct-api top=${fetched.comments.length} total=${fetched.stats.total} maxDepth=${fetched.stats.maxDepth} unavailable=${fetched.stats.unavailable} upstreamCount=${fetched.upstreamCount} lookup=${fetched.lookupMs}ms comments=${fetched.commentsMs}ms totalMs=${Date.now() - start}`);
            return { data: this.envelope(fetched), durationMs: Date.now() - start };
        }
        if (this.provider.commentsMode === 'page-document') {
            const fetched = await this.fetchDocumentComments(pageUrl, null, `manga-comments ${mangaId}`);
            console.log(`[comments] manga-comments ${mangaId} mode=page-document top=${fetched.comments.length} total=${fetched.stats.total} maxDepth=${fetched.stats.maxDepth} unavailable=${fetched.stats.unavailable} upstreamCount=${fetched.upstreamCount} lookup=${fetched.lookupMs}ms totalMs=${Date.now() - start}`);
            return { data: this.envelope(fetched), durationMs: Date.now() - start };
        }
        if (this.provider.commentsMode === 'count-only') {
            const fetched = await this.fetchCountOnlyComments(
                this.provider.mangaCommentCountUrl?.(numericId, pageUrl) ?? null,
                pageUrl,
                `manga-comments ${mangaId}`,
            );
            console.log(`[comments] manga-comments ${mangaId} mode=count-only count=${fetched.upstreamCount} lookup=${fetched.lookupMs}ms totalMs=${Date.now() - start}`);
            return { data: this.envelope(fetched), durationMs: Date.now() - start };
        }
        const fetched = await this.fetchCommentsForPage(this.provider.mangaCommentIdentifier(numericId), pageUrl, pageUrl, `manga-comments ${mangaId}`);
        console.log(`[comments] manga-comments ${mangaId} thread=${fetched.thread.id} rootPages=${fetched.stats.rootPages} replyPages=${fetched.stats.replyPages} treeFills=${fetched.stats.treeFills} top=${fetched.comments.length} total=${fetched.stats.total} maxDepth=${fetched.stats.maxDepth} parents=${fetched.stats.parents} missingReplies=${fetched.stats.missingReplies} unavailable=${fetched.stats.unavailable} unavailableRoots=${fetched.stats.unavailableRoots} upstreamCount=${fetched.upstreamCount} threadCount=${fetched.thread.commentCount} mainCount=${fetched.thread.mainCommentCount} lookup=${fetched.lookupMs}ms comments=${fetched.commentsMs}ms totalMs=${Date.now() - start}`);
        return { data: this.envelope(fetched), durationMs: Date.now() - start };
    }

    async fetchChapterComments(mangaId: string, chapterId: string, chapterNumber: number, chapterUrl?: string): Promise<CommentsFetchResult> {
        const start = Date.now();
        const raw = await this.getCachedMangaDetailRecord(mangaId);
        const numericId = this.numericMangaId(raw, `chapter comments ${mangaId}/${chapterId}`);
        const pageUrl = this.provider.chapterPageUrl(mangaId, chapterId, chapterNumber, chapterUrl);
        const directUrl = this.provider.chapterCommentsUrl?.(chapterId, chapterNumber, pageUrl) ?? null;
        if (directUrl) {
            const fetched = await this.fetchDirectComments(directUrl, pageUrl, `chapter-comments ${mangaId}/${chapterId}`);
            console.log(`[comments] chapter-comments ${mangaId} chapter=${chapterId} number=${chapterNumber} mode=direct-api top=${fetched.comments.length} total=${fetched.stats.total} maxDepth=${fetched.stats.maxDepth} unavailable=${fetched.stats.unavailable} upstreamCount=${fetched.upstreamCount} lookup=${fetched.lookupMs}ms comments=${fetched.commentsMs}ms totalMs=${Date.now() - start}`);
            return { data: this.envelope(fetched), durationMs: Date.now() - start };
        }
        if (this.provider.commentsMode === 'page-document') {
            const countUrl = this.provider.chapterCommentCountUrl?.(chapterId, chapterNumber, pageUrl) ?? null;
            const fetched = await this.fetchDocumentComments(pageUrl, countUrl, `chapter-comments ${mangaId}/${chapterId}`);
            console.log(`[comments] chapter-comments ${mangaId} chapter=${chapterId} number=${chapterNumber} mode=page-document top=${fetched.comments.length} total=${fetched.stats.total} maxDepth=${fetched.stats.maxDepth} unavailable=${fetched.stats.unavailable} upstreamCount=${fetched.upstreamCount} lookup=${fetched.lookupMs}ms totalMs=${Date.now() - start}`);
            return { data: this.envelope(fetched), durationMs: Date.now() - start };
        }
        if (this.provider.commentsMode === 'count-only') {
            const fetched = await this.fetchCountOnlyComments(
                this.provider.chapterCommentCountUrl?.(chapterId, chapterNumber, pageUrl) ?? null,
                pageUrl,
                `chapter-comments ${mangaId}/${chapterId}`,
            );
            console.log(`[comments] chapter-comments ${mangaId} chapter=${chapterId} number=${chapterNumber} mode=count-only count=${fetched.upstreamCount} lookup=${fetched.lookupMs}ms totalMs=${Date.now() - start}`);
            return { data: this.envelope(fetched), durationMs: Date.now() - start };
        }
        const pageIdentifier = this.provider.chapterCommentIdentifier(numericId, chapterNumber);
        const fetched = await this.fetchCommentsForPage(pageIdentifier, pageUrl, pageUrl, `chapter-comments ${mangaId}/${chapterId}`);
        console.log(`[comments] chapter-comments ${mangaId} chapter=${chapterId} number=${chapterNumber} identifier=${pageIdentifier} thread=${fetched.thread.id} rootPages=${fetched.stats.rootPages} replyPages=${fetched.stats.replyPages} treeFills=${fetched.stats.treeFills} top=${fetched.comments.length} total=${fetched.stats.total} maxDepth=${fetched.stats.maxDepth} parents=${fetched.stats.parents} missingReplies=${fetched.stats.missingReplies} unavailable=${fetched.stats.unavailable} unavailableRoots=${fetched.stats.unavailableRoots} upstreamCount=${fetched.upstreamCount} threadCount=${fetched.thread.commentCount} mainCount=${fetched.thread.mainCommentCount} lookup=${fetched.lookupMs}ms comments=${fetched.commentsMs}ms totalMs=${Date.now() - start}`);
        return { data: this.envelope(fetched), durationMs: Date.now() - start };
    }

    private async fetchDirectComments(commentsUrl: string, referer: string, label: string): Promise<FetchedComments> {
        const start = Date.now();
        const headers = { Accept: 'application/json', Referer: referer };
        const fetchContext: BrowserFetchContext = {
            owner: label,
            priority: 'interactive',
            reason: 'comments',
        };
        const response = await this.fetchCommentsJson(commentsUrl, headers, fetchContext);
        const lookupMs = Date.now() - start;
        const result = this.asRecord(response.data.result) ?? this.asRecord(response.data);
        const records = Array.isArray(result?.comments)
            ? result.comments
            : Array.isArray(result?.items)
                ? result.items
                : Array.isArray(response.data.comments)
                    ? response.data.comments
                    : [];
        const comments = this.buildCommentTree(
            records
                .map(record => this.normalizeComment(record))
                .filter((comment): comment is NormalizedMangaComment => comment != null),
        );

        let upstreamCount = this.safeNumber(result?.count ?? result?.total ?? response.data.count ?? records.length);
        if (upstreamCount === 0 && records.length > 0) upstreamCount = records.length;

        const stats = this.commentTreeStats(comments, comments.length > 0 ? 1 : 0, 0, 0, upstreamCount, comments.length);
        return {
            thread: {
                id: 0,
                commentCount: upstreamCount,
                mainCommentCount: comments.length,
                isClosed: false,
            },
            comments,
            cursor: typeof result?.cursor === 'string' ? result.cursor : null,
            pages: comments.length > 0 ? 1 : 0,
            count: stats.total,
            upstreamCount,
            stats,
            lookupMs,
            commentsMs: 0,
        };
    }

    private async getCachedMangaDetailRecord(mangaId: string): Promise<Record<string, unknown>> {
        const result = await this.cache.getMangaForRequest(mangaId, {
            priority: 'interactive',
            reason: 'comments-cache-miss',
        });
        const detail = result.data;
        if (!detail) {
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
        const fetchContext: BrowserFetchContext = {
            owner: label,
            priority: 'interactive',
            reason: 'comments',
        };
        const lookupStart = Date.now();
        const lookup = await this.fetchCommentsJson(lookupUrl, headers, fetchContext);
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

        const newest = await this.loadRootCommentPages(commentsBaseUrl, headers, 'newest', rootById, mainCount, fetchContext);
        count = newest.upstreamCount;
        lastCursor = newest.cursor;

        let rootPages = newest.pages;
        if (mainCount > 0 && rootById.size < mainCount) {
            const supplement = await this.loadRootCommentPages(commentsBaseUrl, headers, null, rootById, mainCount, fetchContext);
            rootPages += supplement.pages;
            lastCursor = supplement.cursor ?? lastCursor;
        }

        const rawItems = [...rootById.values()].sort((a, b) => b.id - a.id);
        for (const comment of rawItems) {
            replyPages += await this.loadRemainingReplies(commentsBaseUrl, headers, comment, fetchContext);
        }
        treeFills += await this.fillMissingCommentTrees(headers, rawItems, new Set(), fetchContext);

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

    private async fetchCountOnlyComments(countUrl: string | null, referer: string, label: string): Promise<FetchedComments> {
        const start = Date.now();
        const headers = { Accept: 'application/json', Referer: referer };
        let upstreamCount = 0;
        if (countUrl) {
            const count = await this.fetchCommentsJson(countUrl, headers, {
                owner: label,
                priority: 'interactive',
                reason: 'comments-count',
            });
            upstreamCount = this.safeNumber(this.asRecord(count.data.result)?.count ?? count.data.count);
        }
        const lookupMs = Date.now() - start;
        const stats: CommentTreeStats = {
            total: 0,
            maxDepth: 0,
            parents: 0,
            missingReplies: 0,
            rootPages: 0,
            replyPages: 0,
            treeFills: 0,
            unavailable: upstreamCount,
            unavailableRoots: upstreamCount,
        };
        return {
            thread: {
                id: 0,
                commentCount: upstreamCount,
                mainCommentCount: upstreamCount,
                isClosed: false,
            },
            comments: [],
            cursor: null,
            pages: 0,
            count: 0,
            upstreamCount,
            stats,
            lookupMs,
            commentsMs: 0,
        };
    }

    private async fetchDocumentComments(pageUrl: string, countUrl: string | null, label: string): Promise<FetchedComments> {
        const start = Date.now();
        if (!this.browserSession) throw new Error(`No provider document owner available for ${label}`);
        const document = await this.browserSession.fetchRuntimeDocument(pageUrl, {
            owner: label,
            priority: 'interactive',
            reason: 'comments-document',
        });
        let comments = this.extractDocumentComments(document.html);
        let upstreamCount = comments.flatMap(comment => this.flattenComment(comment)).length;
        let countMs = 0;
        if (countUrl) {
            const countStart = Date.now();
            try {
                const count = await this.fetchCommentsJson(countUrl, { Accept: 'application/json', Referer: pageUrl }, {
                    owner: label,
                    priority: 'interactive',
                    reason: 'comments-count',
                });
                upstreamCount = Math.max(upstreamCount, this.safeNumber(this.asRecord(count.data.result)?.count ?? count.data.count));
            } finally {
                countMs = Date.now() - countStart;
            }
        }
        let interactiveMs = 0;
        if (comments.length === 0 && upstreamCount > 0 && this.isChapterCommentLabel(label)) {
            const interactiveStart = Date.now();
            const interactive = await this.browserSession.fetchInteractiveDocument(pageUrl, {
                owner: label,
                priority: 'interactive',
                reason: 'comments-panel',
            });
            const extracted = this.extractDocumentComments([
                interactive.html,
                ...interactive.responses.map(response => response.body),
            ].join('\n'));
            comments = extracted.length > 0 ? extracted : comments;
            interactiveMs = Date.now() - interactiveStart;
            console.log(`[comments] document-panel ${label} roots=${comments.length} upstream=${upstreamCount} responses=${interactive.responses.length} buttons=${interactive.buttons.length} panelMs=${interactiveMs}`);
        }
        const stats = this.commentTreeStats(comments, comments.length > 0 ? 1 : 0, 0, 0, upstreamCount, comments.length);
        console.log(`[comments] document-extract ${label} roots=${comments.length} total=${stats.total} upstream=${upstreamCount} docMs=${document.durationMs} countMs=${countMs} panelMs=${interactiveMs} totalMs=${Date.now() - start}`);
        return {
            thread: {
                id: 0,
                commentCount: upstreamCount,
                mainCommentCount: comments.length,
                isClosed: false,
            },
            comments,
            cursor: null,
            pages: comments.length > 0 ? 1 : 0,
            count: stats.total,
            upstreamCount,
            stats,
            lookupMs: document.durationMs + countMs + interactiveMs,
            commentsMs: 0,
        };
    }

    private isChapterCommentLabel(label: string): boolean {
        return label.startsWith('chapter-comments ');
    }

    private extractDocumentComments(html: string): NormalizedMangaComment[] {
        const decodedPayloads: unknown[] = [];
        const payload = this.extractReactRouterPayload(html);
        if (payload) decodedPayloads.push(this.decodeReactRouterPayload(payload));
        decodedPayloads.push(...this.extractJsonPayloads(html));
        const candidates = decodedPayloads.flatMap(value => this.findCommentRecords(value));
        return this.buildCommentTree(candidates);
    }

    private extractJsonPayloads(text: string): unknown[] {
        const out: unknown[] = [];
        const trimmed = text.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                out.push(JSON.parse(trimmed) as unknown);
            } catch {
                // Non-JSON HTML documents are handled by the React Router stream parser.
            }
        }
        return out;
    }

    private extractReactRouterPayload(html: string): unknown[] | null {
        const parts: string[] = [];
        const pattern = /streamController\.enqueue\(("(?:\\.|[^"\\])*")\)/g;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(html)) != null) {
            try {
                parts.push(JSON.parse(match[1]) as string);
            } catch {
                // Ignore malformed stream fragments; later logging reports zero extracted comments.
            }
        }
        if (parts.length === 0) return null;
        try {
            const raw = JSON.parse(parts.join('')) as unknown;
            return Array.isArray(raw) ? raw : null;
        } catch {
            return null;
        }
    }

    private decodeReactRouterPayload(raw: unknown[]): unknown {
        const memo = new Map<number, unknown>();
        const decodeIndex = (index: number): unknown => {
            if (!Number.isFinite(index) || index < 0) return null;
            if (memo.has(index)) return memo.get(index);
            const decoded = decodeValue(raw[index], index);
            memo.set(index, decoded);
            return decoded;
        };
        const decodeKey = (key: string): string => {
            const match = /^_(\d+)$/.exec(key);
            if (!match) return key;
            const decoded = decodeIndex(Number(match[1]));
            return typeof decoded === 'string' || typeof decoded === 'number' ? String(decoded) : key;
        };
        const decodeValue = (value: unknown, index?: number): unknown => {
            if (value == null) return null;
            if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
            if (Array.isArray(value)) {
                const out: unknown[] = [];
                if (index != null) memo.set(index, out);
                for (const item of value) out.push(typeof item === 'number' ? decodeIndex(item) : decodeValue(item));
                return out;
            }
            if (typeof value === 'object') {
                const out: Record<string, unknown> = {};
                if (index != null) memo.set(index, out);
                for (const [key, child] of Object.entries(value)) {
                    out[decodeKey(key)] = typeof child === 'number' ? decodeIndex(child) : decodeValue(child);
                }
                return out;
            }
            return null;
        };
        return decodeIndex(0);
    }

    private findCommentRecords(root: unknown): NormalizedMangaComment[] {
        const seen = new Set<number>();
        const out: NormalizedMangaComment[] = [];
        const visit = (value: unknown) => {
            const raw = this.asRecord(value);
            if (raw) {
                const id = Number(raw.id);
                if (Number.isFinite(id)
                    && id > 0
                    && typeof raw.content === 'string'
                    && ('created_at' in raw || 'user_id' in raw || 'username' in raw || 'parent_id' in raw)) {
                    const comment = this.normalizeComment(raw);
                    if (comment && !seen.has(comment.id)) {
                        seen.add(comment.id);
                        out.push(comment);
                    }
                }
                for (const child of Object.values(raw)) visit(child);
                return;
            }
            if (Array.isArray(value)) {
                for (const child of value) visit(child);
            }
        };
        visit(root);
        return out;
    }

    private buildCommentTree(comments: NormalizedMangaComment[]): NormalizedMangaComment[] {
        const byId = new Map(comments.map(comment => [comment.id, { ...comment, replies: [] as NormalizedMangaComment[] }]));
        const roots: NormalizedMangaComment[] = [];
        for (const comment of byId.values()) {
            const parent = byId.get(comment.parentId);
            if (parent && parent.id !== comment.id) parent.replies.push(comment);
            else roots.push(comment);
        }
        const sortTree = (items: NormalizedMangaComment[]) => {
            items.sort((a, b) => a.id - b.id);
            for (const item of items) {
                item.shownReplies = item.replies.length;
                item.replyCount = Math.max(item.replyCount, item.replies.length);
                sortTree(item.replies);
            }
        };
        sortTree(roots);
        return roots;
    }

    private flattenComment(comment: NormalizedMangaComment): NormalizedMangaComment[] {
        return [comment, ...comment.replies.flatMap(reply => this.flattenComment(reply))];
    }

    private async loadRootCommentPages(
        commentsBaseUrl: string,
        headers: Record<string, string>,
        sort: 'newest' | null,
        rootById: Map<number, NormalizedMangaComment>,
        targetRootCount: number,
        fetchContext: BrowserFetchContext,
    ): Promise<{ pages: number; cursor: string | null; upstreamCount: number }> {
        let cursor: string | null = null;
        let pages = 0;
        let upstreamCount = Number.NaN;
        const seenCursors = new Set<string>();
        const maxPages = this.maxRootPageBudget(targetRootCount);

        while (pages < maxPages) {
            const params = new URLSearchParams();
            if (sort) params.set('sort', sort);
            if (cursor) params.set('cursor', cursor);
            const comments = await this.fetchCommentsJson(`${commentsBaseUrl}?${params}`, headers, fetchContext);
            const result = this.asRecord(comments.data.result) ?? this.asRecord(comments.data);
            const pageItems = Array.isArray(result?.items) ? result.items : [];
            for (const pageItem of pageItems) {
                const item = this.normalizeComment(pageItem);
                if (item && !rootById.has(item.id)) {
                    rootById.set(item.id, item);
                }
            }
            if (!Number.isFinite(upstreamCount)) upstreamCount = Number(result?.count ?? pageItems.length);
            pages++;

            const nextCursor = typeof result?.cursor === 'string' && result.cursor.length > 0 ? result.cursor : null;
            if (targetRootCount > 0 && rootById.size >= targetRootCount) break;
            if (!nextCursor || nextCursor === cursor || seenCursors.has(nextCursor)) break;
            seenCursors.add(nextCursor);
            cursor = nextCursor;
        }

        return { pages, cursor, upstreamCount };
    }

    private maxRootPageBudget(targetRootCount: number): number {
        if (!Number.isFinite(targetRootCount) || targetRootCount <= 0) return COMMENTS_MIN_ROOT_PAGE_BUDGET;
        return Math.max(COMMENTS_MIN_ROOT_PAGE_BUDGET, Math.ceil(targetRootCount) + 5);
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
        const avatar = this.firstString(user.avatar, raw.profile_pic);
        return {
            id: Math.floor(id),
            parentId: this.safeNumber(raw.parentId ?? raw.parent_id),
            author: this.firstString(user.displayName, user.username, raw.display_name, raw.username, 'Unknown'),
            ...(avatar ? { avatar: this.absoluteSafeUrl(avatar) } : {}),
            content: this.partsToText(parts),
            parts,
            createdAt: this.firstString(raw.createdAtFormatted, raw.created_at, raw.createdAt),
            likeCount: this.safeNumber(raw.likeCount ?? raw.likes_count ?? raw.upvotes),
            dislikeCount: this.safeNumber(raw.dislikeCount ?? raw.downvotes),
            replyCount: this.safeNumber(raw.replyCount ?? replies.length),
            shownReplies: this.safeNumber(raw.shownReplies ?? replies.length),
            cursor: this.firstString(raw.cursor),
            replies,
        };
    }

    private async loadRemainingReplies(
        commentsBaseUrl: string,
        headers: Record<string, string>,
        comment: NormalizedMangaComment,
        fetchContext: BrowserFetchContext,
    ): Promise<number> {
        let pages = 0;

        for (const reply of comment.replies) {
            pages += await this.loadRemainingReplies(commentsBaseUrl, headers, reply, fetchContext);
        }

        let cursor = comment.cursor || null;
        const seen = new Set(comment.replies.map(reply => reply.id));
        const seenCursors = new Set<string>();
        const maxOwnPages = Math.max(1, comment.replyCount + 5);
        let ownPages = 0;

        while (cursor && ownPages < maxOwnPages && comment.replies.length < comment.replyCount) {
            const params = new URLSearchParams({
                parent_id: String(comment.id),
                cursor,
            });
            const comments = await this.fetchCommentsJson(`${commentsBaseUrl}?${params}`, headers, fetchContext);
            const result = this.asRecord(comments.data.result) ?? this.asRecord(comments.data);
            const pageItems = Array.isArray(result?.items) ? result.items : [];
            pages++;
            ownPages++;

            for (const pageItem of pageItems) {
                const reply = this.normalizeComment(pageItem);
                if (!reply || seen.has(reply.id)) continue;
                seen.add(reply.id);
                comment.replies.push(reply);
                pages += await this.loadRemainingReplies(commentsBaseUrl, headers, reply, fetchContext);
            }

            const nextCursor = typeof result?.cursor === 'string' && result.cursor.length > 0 ? result.cursor : null;
            if (!nextCursor || nextCursor === cursor || seenCursors.has(nextCursor)) break;
            seenCursors.add(nextCursor);
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
        fetchContext: BrowserFetchContext,
    ): Promise<number> {
        let fills = 0;
        for (const comment of comments) {
            if (seen.has(comment.id)) continue;
            seen.add(comment.id);

            if (comment.replyCount > comment.replies.length) {
                const tree = await this.fetchCommentsJson(this.provider.commentTreeUrl(comment.id), headers, fetchContext);
                const fresh = this.normalizeComment(this.asRecord(tree.data.result) ?? tree.data);
                fills++;
                if (fresh) this.mergeComment(comment, fresh);
            }

            fills += await this.fillMissingCommentTrees(headers, comment.replies, seen, fetchContext);
        }
        return fills;
    }

    private async fetchCommentsJson(
        url: string,
        headers: Record<string, string>,
        context: BrowserFetchContext,
    ): Promise<{ data: Record<string, unknown> }> {
        let lastError: unknown;
        for (let attempt = 1; attempt <= COMMENTS_PAGE_ATTEMPTS; attempt++) {
            const start = Date.now();
            try {
                if (this.provider.id === 'mangadotnet' && this.browserSession) {
                    const result = await this.browserSession.fetchRuntimeApi(url, context);
                    return { data: this.asRecord(result.data) ?? {} };
                }
                return await proxyFetchJson<Record<string, unknown>>(url, {
                    headers,
                    cloudflareProtected: true,
                }, COMMENTS_PAGE_TIMEOUT_MS);
            } catch (error) {
                lastError = error;
                if (!this.isRetryableCommentFetchError(error) || attempt >= COMMENTS_PAGE_ATTEMPTS) throw error;
                console.log(`[comments] retry owner=${context.owner ?? 'unknown'} attempt=${attempt + 1}/${COMMENTS_PAGE_ATTEMPTS} afterMs=${Date.now() - start} url=${this.compactCommentUrl(url)} error=${this.errorMessage(error)}`);
                await this.sleep(COMMENTS_RETRY_DELAY_MS * attempt);
            }
        }
        throw lastError;
    }

    private isRetryableCommentFetchError(error: unknown): boolean {
        if (error instanceof CloudflareError) return true;
        if (error instanceof UpstreamError) return error.status === 429 || error.status >= 500;
        return error instanceof DOMException && error.name === 'TimeoutError';
    }

    private compactCommentUrl(url: string): string {
        try {
            const parsed = new URL(url);
            return `${parsed.pathname}${parsed.search}`;
        } catch {
            return url;
        }
    }

    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
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

    private absoluteSafeUrl(url: string): string {
        if (!url) return '';
        try {
            return new URL(url, this.provider.baseUrl).href;
        } catch {
            return url;
        }
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
