import { chromium, type BrowserContext, type Page } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import { proxyFetchJson } from '../utils/proxyFetch.js';
import type { ServerMangaProvider } from '../providers/types.js';

const CLOAKBROWSER_PATH = path.join(os.homedir(), '.cloakbrowser/chromium-145.0.7632.159.7/chrome');
const PROFILE_BASE = path.join(os.homedir(), '.cloakbrowser-profiles');

const STEALTH_ARGS = [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--fingerprint=52495',
    '--fingerprint-platform=windows',
    '--fingerprint-gpu-vendor=Google Inc. (NVIDIA)',
    '--fingerprint-gpu-renderer=ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 (0x00002484) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    '--disable-gpu',
    '--disable-gpu-compositing',
    '--window-size=1920,1080',
];

const IGNORE_DEFAULT_ARGS = ['--enable-automation', '--enable-unsafe-swiftshader'];

const CHAPTER_DETAIL_CACHE_TTL_MS = 10 * 60 * 1000;
const CHAPTER_DETAIL_CACHE_LIMIT = 24;
const CHAPTER_LIST_CACHE_TTL_MS = 5 * 60 * 1000;
const CHAPTER_LIST_CACHE_LIMIT = 64;
const CHAPTER_LIST_PAGE_SIZE = 20;
const MANGA_DETAIL_CACHE_TTL_MS = 10 * 60 * 1000;
const MANGA_DETAIL_CACHE_LIMIT = 128;
const COMMENTS_PAGE_LIMIT = 10;
const COMMENT_REPLY_PAGE_LIMIT = 20;
const COMMENT_TREE_FILL_LIMIT = 40;

export interface BrowserFetchResult {
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

function valueKind(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}

interface ChapterDetailCacheEntry {
    data: unknown;
    capturedAt: number;
}

interface ChapterListCacheEntry {
    data: unknown;
    capturedAt: number;
}

interface MangaDetailCacheEntry {
    data: unknown;
    capturedAt: number;
}

export class BrowserSession {
    private context: BrowserContext | null = null;
    private runtimeHttpPage: Page | null = null;
    private runtimeHttpInit: Promise<void> | null = null;
    private _ready = false;
    private initPromise: Promise<void> | null = null;
    private readonly profileDir: string;
    private readonly mangaDetailCache = new Map<string, MangaDetailCacheEntry>();
    private readonly chapterPageCache = new Map<string, ChapterListCacheEntry>();
    private readonly chapterPageInflight = new Map<string, Promise<unknown>>();
    private readonly chapterDetailCache = new Map<string, ChapterDetailCacheEntry>();
    private readonly chapterDetailInflight = new Map<string, Promise<unknown>>();

    constructor(
        private readonly provider: ServerMangaProvider,
    ) {
        this.profileDir = path.join(PROFILE_BASE, `${provider.domain}-session`);
    }

    get ready(): boolean {
        return this._ready;
    }

    async init(): Promise<void> {
        if (this._ready) return;
        if (this.initPromise) return this.initPromise;
        this.initPromise = this.doInit();
        return this.initPromise;
    }

    private async doInit(): Promise<void> {
        const start = Date.now();
        console.log(`[browserSession] init ${this.provider.domain}`);

        try {
            this.context = await chromium.launchPersistentContext(this.profileDir, {
                executablePath: CLOAKBROWSER_PATH,
                args: STEALTH_ARGS,
                ignoreDefaultArgs: IGNORE_DEFAULT_ARGS,
                headless: false,
                viewport: { width: 1920, height: 1080 },
            });

            console.log(`[browserSession] ready ${this.provider.domain} ${Date.now() - start}ms`);
            this._ready = true;
        } catch (e) {
            this._ready = false;
            this.initPromise = null;
            if (this.context) {
                await this.context.close().catch(() => {});
                this.context = null;
                this.runtimeHttpPage = null;
                this.runtimeHttpInit = null;
            }
            throw e;
        }
    }

    async fetchMangaDetail(mangaId: string): Promise<BrowserFetchResult> {
        await this.init();
        const start = Date.now();
        const cached = this.getCachedMangaDetail(mangaId);
        if (cached) {
            console.log(`[browserSession] manga-detail-cache hit ${mangaId}`);
            return { data: cached, durationMs: Date.now() - start };
        }

        const data = await this.fetchMangaDetailViaRuntimeHttp(mangaId);
        this.rememberMangaDetail(mangaId, data);
        return { data, durationMs: Date.now() - start };
    }

    async fetchMangaComments(mangaId: string): Promise<BrowserFetchResult> {
        await this.init();
        const start = Date.now();
        const raw = await this.getMangaDetailRecord(mangaId, true);
        const numericId = this.numericMangaId(raw, `comments ${mangaId}`);
        const pageUrl = this.provider.mangaPageUrl(mangaId, raw?.url);
        const fetched = await this.fetchCommentsForPage(this.provider.mangaCommentIdentifier(numericId), pageUrl, pageUrl, `manga-comments ${mangaId}`);
        console.log(`[browserSession] manga-comments ${mangaId} thread=${fetched.thread.id} rootPages=${fetched.stats.rootPages} replyPages=${fetched.stats.replyPages} treeFills=${fetched.stats.treeFills} top=${fetched.comments.length} total=${fetched.stats.total} maxDepth=${fetched.stats.maxDepth} parents=${fetched.stats.parents} missingReplies=${fetched.stats.missingReplies} unavailable=${fetched.stats.unavailable} unavailableRoots=${fetched.stats.unavailableRoots} upstreamCount=${fetched.upstreamCount} threadCount=${fetched.thread.commentCount} mainCount=${fetched.thread.mainCommentCount} lookup=${fetched.lookupMs}ms comments=${fetched.commentsMs}ms totalMs=${Date.now() - start}`);

        return {
            data: {
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
            },
            durationMs: Date.now() - start,
        };
    }

    async fetchChapterComments(mangaId: string, chapterId: string, chapterNumber: number, chapterUrl?: string): Promise<BrowserFetchResult> {
        await this.init();
        const start = Date.now();
        const raw = await this.getMangaDetailRecord(mangaId, false);
        const numericId = this.numericMangaId(raw, `chapter comments ${mangaId}/${chapterId}`);
        const pageUrl = this.provider.chapterPageUrl(mangaId, chapterId, chapterNumber, chapterUrl);
        const pageIdentifier = this.provider.chapterCommentIdentifier(numericId, chapterNumber);
        const fetched = await this.fetchCommentsForPage(pageIdentifier, pageUrl, pageUrl, `chapter-comments ${mangaId}/${chapterId}`);
        console.log(`[browserSession] chapter-comments ${mangaId} chapter=${chapterId} number=${chapterNumber} identifier=${pageIdentifier} thread=${fetched.thread.id} rootPages=${fetched.stats.rootPages} replyPages=${fetched.stats.replyPages} treeFills=${fetched.stats.treeFills} top=${fetched.comments.length} total=${fetched.stats.total} maxDepth=${fetched.stats.maxDepth} parents=${fetched.stats.parents} missingReplies=${fetched.stats.missingReplies} unavailable=${fetched.stats.unavailable} unavailableRoots=${fetched.stats.unavailableRoots} upstreamCount=${fetched.upstreamCount} threadCount=${fetched.thread.commentCount} mainCount=${fetched.thread.mainCommentCount} lookup=${fetched.lookupMs}ms comments=${fetched.commentsMs}ms totalMs=${Date.now() - start}`);

        return {
            data: {
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
            },
            durationMs: Date.now() - start,
        };
    }

    private async getMangaDetailRecord(mangaId: string, forceRefresh: boolean): Promise<Record<string, unknown>> {
        let detail = this.getCachedMangaDetail(mangaId);
        if (!detail || forceRefresh) {
            detail = (await this.fetchMangaDetail(mangaId)).data;
        }
        return this.asRecord(this.asRecord(detail)?.result) ?? this.asRecord(detail) ?? {};
    }

    private numericMangaId(raw: Record<string, unknown>, label: string): number {
        const numericId = Number(raw?.id);
        if (!Number.isFinite(numericId) || numericId <= 0) {
            throw new Error(`No numeric manga id available for ${label}`);
        }
        return numericId;
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
                if (fresh) {
                    this.mergeComment(comment, fresh);
                }
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
            if (existing) {
                this.mergeComment(existing, sourceReply);
            } else {
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

    private getCachedMangaDetail(mangaId: string): unknown | null {
        const cached = this.mangaDetailCache.get(mangaId);
        if (!cached) return null;
        if (Date.now() - cached.capturedAt > MANGA_DETAIL_CACHE_TTL_MS) {
            this.mangaDetailCache.delete(mangaId);
            return null;
        }
        this.mangaDetailCache.delete(mangaId);
        this.mangaDetailCache.set(mangaId, cached);
        return cached.data;
    }

    private rememberMangaDetail(mangaId: string, data: unknown): void {
        this.mangaDetailCache.set(mangaId, { data, capturedAt: Date.now() });
        while (this.mangaDetailCache.size > MANGA_DETAIL_CACHE_LIMIT) {
            const oldest = this.mangaDetailCache.keys().next().value;
            if (!oldest) break;
            this.mangaDetailCache.delete(oldest);
        }
    }

    async fetchChapterListPage(mangaId: string, page: number, pageSize = CHAPTER_LIST_PAGE_SIZE): Promise<BrowserFetchResult> {
        await this.init();
        const start = Date.now();
        try {
            const data = await this.fetchChapterPageViaRuntimeHttp(mangaId, page, pageSize);
            return { data, durationMs: Date.now() - start };
        } catch (e) {
            const durationMs = Date.now() - start;
            const msg = (e as Error)?.message ?? String(e);
            console.log(`[browserSession] fetch-error ${mangaId} page=${page} ${durationMs}ms ${msg}`);
            throw e;
        }
    }

    async fetchChapterImages(mangaId: string, chapterId: string): Promise<BrowserFetchResult> {
        await this.init();
        const start = Date.now();
        try {
            const data = await this.fetchChapterDetailCached(mangaId, chapterId);
            return { data, durationMs: Date.now() - start };
        } catch (e) {
            const durationMs = Date.now() - start;
            const msg = (e as Error)?.message ?? String(e);
            console.log(`[browserSession] fetch-error ${mangaId} chapter=${chapterId} ${durationMs}ms ${msg}`);
            throw e;
        }
    }

    private chapterDetailKey(mangaId: string, chapterId: string): string {
        return `${mangaId}/${chapterId}`;
    }

    private getCachedChapterDetail(key: string): unknown | null {
        const cached = this.chapterDetailCache.get(key);
        if (!cached) return null;
        if (Date.now() - cached.capturedAt > CHAPTER_DETAIL_CACHE_TTL_MS) {
            this.chapterDetailCache.delete(key);
            return null;
        }
        this.chapterDetailCache.delete(key);
        this.chapterDetailCache.set(key, cached);
        return cached.data;
    }

    private rememberChapterDetail(key: string, data: unknown): void {
        this.chapterDetailCache.set(key, { data, capturedAt: Date.now() });
        while (this.chapterDetailCache.size > CHAPTER_DETAIL_CACHE_LIMIT) {
            const oldest = this.chapterDetailCache.keys().next().value;
            if (!oldest) break;
            this.chapterDetailCache.delete(oldest);
        }
    }

    private async fetchChapterDetailCached(mangaId: string, chapterId: string): Promise<unknown> {
        const key = this.chapterDetailKey(mangaId, chapterId);
        const cached = this.getCachedChapterDetail(key);
        if (cached) {
            console.log(`[browserSession] chapter-cache hit ${key} reason=user`);
            return cached;
        }

        const inflight = this.chapterDetailInflight.get(key);
        if (inflight) {
            console.log(`[browserSession] chapter-cache join ${key} reason=user`);
            return inflight;
        }

        const promise = this.fetchChapterDetailViaRuntimeHttp(mangaId, chapterId)
            .then(data => {
                this.rememberChapterDetail(key, data);
                return data;
            })
            .finally(() => this.chapterDetailInflight.delete(key));

        this.chapterDetailInflight.set(key, promise);
        return promise;
    }

    private chapterPageKey(mangaId: string, page: number, pageSize = CHAPTER_LIST_PAGE_SIZE): string {
        return `${mangaId}:${pageSize}:${page}`;
    }

    private getCachedChapterPage(mangaId: string, page: number, pageSize = CHAPTER_LIST_PAGE_SIZE): unknown | null {
        const key = this.chapterPageKey(mangaId, page, pageSize);
        const cached = this.chapterPageCache.get(key);
        if (!cached) return null;
        if (Date.now() - cached.capturedAt > CHAPTER_LIST_CACHE_TTL_MS) {
            this.chapterPageCache.delete(key);
            return null;
        }
        this.chapterPageCache.delete(key);
        this.chapterPageCache.set(key, cached);
        return cached.data;
    }

    private rememberChapterPage(mangaId: string, page: number, data: unknown, pageSize = CHAPTER_LIST_PAGE_SIZE): void {
        this.chapterPageCache.set(this.chapterPageKey(mangaId, page, pageSize), { data, capturedAt: Date.now() });
        while (this.chapterPageCache.size > CHAPTER_LIST_CACHE_LIMIT) {
            const oldest = this.chapterPageCache.keys().next().value;
            if (!oldest) break;
            this.chapterPageCache.delete(oldest);
        }
    }

    private async fetchChapterDetailViaRuntimeHttp(mangaId: string, chapterId: string): Promise<unknown> {
        const t0 = Date.now();
        const detail = await this.runtimeHttpGet<Record<string, unknown>>(mangaId, this.provider.chapterImagesPath(chapterId));
        const normalized = this.provider.normalizeChapterImages(detail);
        const data = {
            status: 'ok',
            result: {
                source: normalized.source,
                targetCount: normalized.targetCount,
                pages: normalized.pages,
            },
        };
        if (normalized.pages.length === 0 || normalized.pages.length !== normalized.targetCount) {
            console.log(`[browserSession] chapter ${mangaId}/${chapterId} page-load reason=user source=${normalized.source}-incomplete pages=${normalized.pages.length} targetCount=${normalized.targetCount} ${Date.now() - t0}ms`);
            throw new Error(`Runtime HTTP returned incomplete chapter images for ${mangaId}/${chapterId}: pages=${normalized.pages.length} targetCount=${normalized.targetCount}`);
        }
        console.log(`[browserSession] chapter ${mangaId}/${chapterId} page-load reason=user source=${normalized.source} pages=${normalized.pages.length} targetCount=${normalized.targetCount} ${Date.now() - t0}ms`);
        return data;
    }

    private describeChapterListPayload(data: unknown): string {
        if (!data || typeof data !== 'object') return `root=${valueKind(data)}`;
        const root = data as Record<string, unknown>;
        const result = root.result;
        if (!result || typeof result !== 'object') {
            return `root=object status=${String(root.status ?? 'none')} result=${valueKind(result)} keys=${Object.keys(root).slice(0, 8).join(',') || 'none'}`;
        }

        const r = result as Record<string, unknown>;
        const items = r.items;
        const pagination = r.pagination ?? r.meta;
        return `root=object status=${String(root.status ?? 'none')} result=object items=${Array.isArray(items) ? items.length : valueKind(items)} pagination=${valueKind(pagination)} resultKeys=${Object.keys(r).slice(0, 8).join(',') || 'none'}`;
    }

    private assertChapterListPayload(mangaId: string, pageNum: number, data: unknown): any {
        const result = this.asRecord(this.asRecord(data)?.result);
        const items = result && typeof result === 'object'
            ? (result as Record<string, unknown>).items
            : undefined;

        if (!Array.isArray(items)) {
            const shape = this.describeChapterListPayload(data);
            throw new Error(`Invalid chapter-list payload ${mangaId} page=${pageNum} ${shape}`);
        }

        return data;
    }

    private async ensureRuntimeHttpPage(mangaId: string): Promise<Page> {
        if (this.runtimeHttpPage && !this.runtimeHttpPage.isClosed()) return this.runtimeHttpPage;
        if (!this.runtimeHttpInit) {
            this.runtimeHttpInit = (async () => {
                const start = Date.now();
                const page = await this.context!.newPage();
                await page.goto(this.provider.runtimePageUrl(mangaId), { waitUntil: 'domcontentloaded', timeout: 15_000 });
                await this.provider.resolveRuntimeHttpClient(page, mangaId, 'browserSession');
                this.runtimeHttpPage = page;
                console.log(`[browserSession] runtime-http ready ${mangaId} ${Date.now() - start}ms`);
            })().finally(() => {
                this.runtimeHttpInit = null;
            });
        }
        await this.runtimeHttpInit;
        if (!this.runtimeHttpPage || this.runtimeHttpPage.isClosed()) {
            throw new Error(`${this.provider.name} runtime HTTP page unavailable`);
        }
        return this.runtimeHttpPage;
    }

    private async resetRuntimeHttpPage(reason: string): Promise<void> {
        const page = this.runtimeHttpPage;
        this.runtimeHttpPage = null;
        this.runtimeHttpInit = null;
        if (page && !page.isClosed()) {
            await page.close().catch(e => {
                console.log(`[browserSession] runtime-http page-close failed reason=${reason}: ${(e as Error)?.message ?? e}`);
            });
        }
    }

    private async runtimeHttpGet<T>(mangaId: string, apiPath: string, params?: Record<string, unknown>, attempt = 1): Promise<T> {
        const page = await this.ensureRuntimeHttpPage(mangaId);
        try {
            return await page.evaluate(
                async ({ apiPath, params }) => {
                    const http = (globalThis as any).__providerRuntimeHttp;
                    if (!http?.get) throw new Error('Provider runtime HTTP client unavailable');
                    return http.get(apiPath, params ? { params } : undefined);
                },
                { apiPath, params },
            ) as T;
        } catch (e) {
            if (attempt >= 2) throw e;
            const msg = (e as Error)?.message ?? String(e);
            console.log(`[browserSession] runtime-http reset ${mangaId} path=${apiPath} reason=${msg}`);
            await this.resetRuntimeHttpPage('runtime-http-error');
            return this.runtimeHttpGet<T>(mangaId, apiPath, params, attempt + 1);
        }
    }

    private async fetchMangaDetailViaRuntimeHttp(mangaId: string): Promise<unknown> {
        const start = Date.now();
        const detail = await this.runtimeHttpGet<Record<string, unknown>>(mangaId, this.provider.mangaDetailPath(mangaId));
        const recommendations = await this.fetchMangaRecommendationsViaRuntimeHttp(mangaId);
        const data = {
            status: 'ok',
            result: {
                ...detail,
                recommendations,
            },
        };
        const tags = Array.isArray(detail?.tags) ? detail.tags.length : 0;
        const genres = Array.isArray(detail?.genres) ? detail.genres.length : 0;
        console.log(`[browserSession] manga-detail runtime-http ${mangaId} recommendations=${recommendations.length} genres=${genres} tags=${tags} ${Date.now() - start}ms`);
        return data;
    }

    private async fetchMangaRecommendationsViaRuntimeHttp(mangaId: string): Promise<unknown[]> {
        const first = await this.runtimeHttpGet<Record<string, unknown>>(mangaId, this.provider.mangaRecommendationsPath(mangaId), { page: 1 });
        const items = Array.isArray(first?.items) ? [...first.items] : [];
        const meta = this.asRecord(first?.meta) ?? this.asRecord(first?.pagination);
        const lastPage = Number(meta?.lastPage ?? meta?.last_page ?? 1);
        if (!Number.isFinite(lastPage) || lastPage <= 1) return items;

        const pages = Array.from({ length: Math.floor(lastPage) - 1 }, (_, i) => i + 2);
        const settled = await Promise.allSettled(
            pages.map(page => this.runtimeHttpGet<Record<string, unknown>>(mangaId, this.provider.mangaRecommendationsPath(mangaId), { page })),
        );
        let failed = 0;
        for (const result of settled) {
            if (result.status === 'fulfilled') {
                const pageItems = Array.isArray(result.value?.items) ? result.value.items : [];
                items.push(...pageItems);
            } else {
                failed++;
            }
        }
        if (failed > 0) {
            console.log(`[browserSession] manga-detail recommendations partial ${mangaId} pages=${lastPage} failed=${failed}`);
        }
        return items;
    }

    private async fetchChapterPageViaRuntimeHttp(mangaId: string, pageNum: number, pageSize = CHAPTER_LIST_PAGE_SIZE): Promise<any> {
        const cached = this.getCachedChapterPage(mangaId, pageNum, pageSize);
        if (cached) {
            console.log(`[browserSession] chapter-page-cache hit ${mangaId} limit=${pageSize} page=${pageNum}`);
            return cached;
        }
        const key = this.chapterPageKey(mangaId, pageNum, pageSize);
        const inflight = this.chapterPageInflight.get(key);
        if (inflight) {
            console.log(`[browserSession] chapter-page-cache join ${mangaId} limit=${pageSize} page=${pageNum}`);
            return inflight;
        }

        const start = Date.now();
        const promise = (async () => {
            const data = await this.runtimeHttpGet<Record<string, unknown>>(mangaId, this.provider.chapterListPath(mangaId), this.provider.chapterListParams(pageNum, pageSize));
            const fetchMs = Date.now() - start;

            const envelope = this.assertChapterListPayload(mangaId, pageNum, {
                status: 'ok',
                result: {
                    items: data?.items ?? [],
                    pagination: data?.meta ?? data?.pagination,
                },
            });
            const items = Array.isArray(data?.items) ? data.items.length : 0;
            const pagination = this.asRecord(data?.meta) ?? this.asRecord(data?.pagination);
            const total = Number(pagination?.total ?? items);
            console.log(`[browserSession] runtime-http chapters ${mangaId} page=${pageNum} limit=${pageSize} items=${items} total=${Number.isFinite(total) ? total : items} ${fetchMs}ms`);
            this.rememberChapterPage(mangaId, pageNum, envelope, pageSize);
            return envelope;
        })().finally(() => this.chapterPageInflight.delete(key));
        this.chapterPageInflight.set(key, promise);
        return promise;
    }

    async destroy(): Promise<void> {
        this._ready = false;
        if (this.context) {
            await this.context.close().catch(() => {});
            this.context = null;
            this.runtimeHttpPage = null;
            this.runtimeHttpInit = null;
            this.initPromise = null;
            console.log(`[browserSession] destroyed ${this.provider.domain}`);
        }
    }
}
