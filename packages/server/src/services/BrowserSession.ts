import { chromium, type BrowserContext, type Page } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import { assertJsonEnvelopeOk, proxyFetchJson, UpstreamBodyError } from '../utils/proxyFetch.js';

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

const CHAPTER_LIST_PATTERN = /\/manga\/([^/]+)\/chapters/;
const CHAPTER_DETAIL_PATTERN = /\/chapters\/([^/?]+)/;
const COMIX_API_BASE_PATH = '/api/v1';
const MAX_WORKERS = 4;
const CHAPTER_DETAIL_CACHE_TTL_MS = 10 * 60 * 1000;
const CHAPTER_DETAIL_CACHE_LIMIT = 24;
const CHAPTER_LIST_CACHE_TTL_MS = 5 * 60 * 1000;
const CHAPTER_LIST_CACHE_LIMIT = 64;
const CHAPTER_LIST_WARM_WORKERS = 2;
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

const enum Priority { USER = 0, PREWARM = 1 }

function isSignedApiRejected(err: unknown): boolean {
    return err instanceof UpstreamBodyError;
}

interface WorkItem {
    mangaId: string;
    priority: Priority;
    forceRefresh: boolean;
    resolve: (sig: string) => void;
    reject: (err: Error) => void;
}

interface CapturedTitleData {
    sig: string;
    detail?: unknown;
}

interface SignedChapterRequest {
    kind: 'chapter-list';
    mangaId: string;
    page: number;
}

interface SignedChapterDetailRequest {
    kind: 'chapter-detail';
    mangaId: string;
    chapterId: string;
    signingPageUrl?: string;
}

type SignedRequest = SignedChapterRequest | SignedChapterDetailRequest;

interface ChapterDetailWarmRequest {
    mangaId: string;
    chapterId: string;
    signingPageUrl: string;
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

interface SignatureLease {
    value: string;
    capturedAt: number;
}

class NavigationScheduler {
    private readonly queue: WorkItem[] = [];
    private readonly sigCache = new Map<string, SignatureLease>();
    private readonly inflight = new Set<string>();
    private activeWorkers = 0;
    private context: BrowserContext | null = null;
    private onDetail: ((mangaId: string, detail: unknown) => void) | null = null;

    get cacheSize(): number { return this.sigCache.size; }

    setContext(ctx: BrowserContext): void {
        this.context = ctx;
    }

    setDetailCallback(fn: (mangaId: string, detail: unknown) => void): void {
        this.onDetail = fn;
    }

    getCachedSig(mangaId: string): SignatureLease | undefined {
        return this.sigCache.get(mangaId);
    }

    invalidate(mangaId: string, reason: string): void {
        const deleted = this.sigCache.delete(mangaId);
        console.log(`[navScheduler] invalidate ${mangaId} reason=${reason} deleted=${deleted} cache=${this.sigCache.size}`);
    }

    acquire(mangaId: string, priority: Priority, forceRefresh = false): Promise<string> {
        if (forceRefresh) {
            this.invalidate(mangaId, 'force-refresh');
        } else {
            const cached = this.sigCache.get(mangaId);
            if (cached) return Promise.resolve(cached.value);
        }

        const existing = this.queue.find(w => w.mangaId === mangaId);
        if (existing) {
            if (priority < existing.priority) existing.priority = priority;
            existing.forceRefresh = existing.forceRefresh || forceRefresh;
            return new Promise((resolve, reject) => {
                const orig = { resolve: existing.resolve, reject: existing.reject };
                existing.resolve = (sig) => { orig.resolve(sig); resolve(sig); };
                existing.reject = (err) => { orig.reject(err); reject(err); };
            });
        }

        if (this.inflight.has(mangaId)) {
            return new Promise((resolve, reject) => {
                this.queue.push({ mangaId, priority, forceRefresh, resolve, reject });
            });
        }

        return new Promise((resolve, reject) => {
            this.queue.push({ mangaId, priority, forceRefresh, resolve, reject });
            this.drain();
        });
    }

    submitPrewarm(mangaIds: string[]): { queued: number; skipped: number } {
        let queued = 0;
        let skipped = 0;

        for (const id of mangaIds) {
            if (this.sigCache.has(id) || this.inflight.has(id) || this.queue.some(w => w.mangaId === id)) {
                skipped++;
                continue;
            }
            queued++;
            this.queue.push({
                mangaId: id,
                priority: Priority.PREWARM,
                forceRefresh: false,
                resolve: () => {},
                reject: () => {},
            });
        }

        if (queued > 0) this.drain();
        return { queued, skipped };
    }

    private drain(): void {
        while (this.activeWorkers < MAX_WORKERS && this.queue.length > 0) {
            this.queue.sort((a, b) => a.priority - b.priority);
            const item = this.queue.shift()!;

            const cached = item.forceRefresh ? undefined : this.sigCache.get(item.mangaId);
            if (cached) {
                item.resolve(cached.value);
                continue;
            }

            this.activeWorkers++;
            this.inflight.add(item.mangaId);
            this.runWorker(item);
        }
    }

    private async runWorker(item: WorkItem): Promise<void> {
        const { mangaId } = item;
        const label = item.priority === Priority.USER ? 'user' : 'prewarm';

        try {
            const page = await this.context!.newPage();
            const t0 = Date.now();

            try {
                const captured = await this.captureSignature(page, mangaId);
                const now = Date.now();
                this.sigCache.set(mangaId, {
                    value: captured.sig,
                    capturedAt: now,
                });
                if (captured.detail) this.onDetail?.(mangaId, captured.detail);
                console.log(`[navScheduler] ${label} ${mangaId} sig=${captured.sig.slice(0, 16)}… detail=${captured.detail ? 'yes' : 'no'} ${Date.now() - t0}ms cache=${this.cacheSize}`);
                item.resolve(captured.sig);

                for (let i = this.queue.length - 1; i >= 0; i--) {
                    if (this.queue[i].mangaId === mangaId) {
                        this.queue[i].resolve(captured.sig);
                        this.queue.splice(i, 1);
                    }
                }
            } finally {
                await page.close().catch(e => {
                    console.log(`[navScheduler] page-close failed ${mangaId}: ${(e as Error)?.message ?? e}`);
                });
            }
        } catch (e) {
            const msg = (e as Error)?.message ?? String(e);
            console.log(`[navScheduler] ${label} ${mangaId} failed: ${msg}`);
            item.reject(e as Error);

            for (let i = this.queue.length - 1; i >= 0; i--) {
                if (this.queue[i].mangaId === mangaId) {
                    this.queue[i].reject(e as Error);
                    this.queue.splice(i, 1);
                }
            }
        } finally {
            this.inflight.delete(mangaId);
            this.activeWorkers--;
            this.drain();
        }
    }

    private captureSignature(page: Page, mangaId: string): Promise<CapturedTitleData> {
        return new Promise<CapturedTitleData>((resolve, reject) => {
            let settled = false;
            const startedAt = Date.now();
            const detailPromise = this.captureInitialMangaDetailFromDocument(page, mangaId, startedAt);

            const timeout = setTimeout(() => {
                if (settled) return;
                settled = true;
                page.off('request', handler);
                reject(new Error('Timed out waiting for signed chapters request'));
            }, 15_000);

            const handler = async (req: import('playwright').Request) => {
                if (settled) return;
                const url = req.url();
                if (!url.includes(`/manga/${mangaId}/chapters`) || !url.includes('_=')) return;

                clearTimeout(timeout);
                page.off('request', handler);

                const sig = new URL(url).searchParams.get('_');
                if (sig) {
                    const signedAtMs = Date.now() - startedAt;
                    console.log(`[navScheduler] signed-request ${mangaId} after=${signedAtMs}ms`);
                    const detailStart = Date.now();
                    const detail = await detailPromise.catch((e) => {
                        const msg = (e as Error)?.message ?? String(e);
                        console.log(`[navScheduler] initial-detail-error ${mangaId} after=${Date.now() - detailStart}ms ${msg}`);
                        return undefined;
                    });
                    console.log(`[navScheduler] initial-detail ${mangaId} found=${detail ? 'yes' : 'no'} after=${Date.now() - detailStart}ms total=${Date.now() - startedAt}ms`);
                    settled = true;
                    resolve({ sig, detail });
                } else {
                    settled = true;
                    reject(new Error('Signed request found but _ param missing'));
                }
            };

            page.on('request', handler);
            page.goto(`https://comix.to/title/${mangaId}`, {
                waitUntil: 'commit',
                timeout: 15_000,
            }).catch(e => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    page.off('request', handler);
                    reject(e);
                }
            });
        });
    }

    private async captureInitialMangaDetailFromDocument(page: Page, mangaId: string, startedAt: number): Promise<unknown | undefined> {
        const response = await page.waitForResponse(res => {
            const url = res.url();
            if (res.request().resourceType() !== 'document') return false;
            if (!url.startsWith(`https://comix.to/title/${mangaId}`)) return false;
            return res.status() >= 200 && res.status() < 400;
        }, { timeout: 15_000 });

        const responseMs = Date.now() - startedAt;
        const textStart = Date.now();
        const html = await response.text();
        const textMs = Date.now() - textStart;
        const extractStart = Date.now();
        const raw = this.extractInitialDataJson(html);
        const extractMs = Date.now() - extractStart;
        if (!raw) {
            console.log(`[navScheduler] initial-detail-breakdown ${mangaId} source=document response=${responseMs}ms text=${textMs}ms extract=${extractMs}ms bytes=${html.length} missing-script`);
            return undefined;
        }

        const parseStart = Date.now();
        const parsed = JSON.parse(raw) as { queries?: Record<string, unknown> };
        const queries = parsed.queries ?? {};
        let detail: Record<string, unknown> | undefined;
        let recommendations: unknown[] = [];
        let recommendationLastPage = 1;
        for (const [key, value] of Object.entries(queries)) {
            const queryKey = this.parseInitialDataQueryKey(key);
            if (!this.isMangaInitialDataQuery(queryKey, mangaId)) continue;
            if (queryKey[1] === 'detail') {
                detail = value as Record<string, unknown>;
            } else if (queryKey[1] === 'recommended') {
                const payload = this.extractRecommendationPayload(value);
                recommendations = payload.items;
                recommendationLastPage = payload.lastPage;
            }
        }
        if (recommendationLastPage > 1) {
            const extra = await this.fetchRecommendationPages(page, mangaId, recommendationLastPage).catch((e) => {
                const msg = (e as Error)?.message ?? String(e);
                console.log(`[navScheduler] recommended-extra-error ${mangaId} pages=2-${recommendationLastPage} ${msg}`);
                return [];
            });
            const seen = new Set(recommendations.map(item => this.recommendationId(item)));
            for (const item of extra) {
                const id = this.recommendationId(item);
                if (id && seen.has(id)) continue;
                if (id) seen.add(id);
                recommendations.push(item);
            }
        }
        const parseMs = Date.now() - parseStart;
        if (!detail) {
            console.log(`[navScheduler] initial-detail-breakdown ${mangaId} source=document response=${responseMs}ms text=${textMs}ms extract=${extractMs}ms parse=${parseMs}ms bytes=${raw.length} recommendations=${recommendations.length} missing-query`);
            return undefined;
        }
        console.log(`[navScheduler] initial-detail-breakdown ${mangaId} source=document response=${responseMs}ms text=${textMs}ms extract=${extractMs}ms parse=${parseMs}ms bytes=${raw.length} recommendations=${recommendations.length}`);
        return { status: 'ok', result: { ...detail, recommendations } };
    }

    private async fetchRecommendationPages(page: Page, mangaId: string, lastPage: number): Promise<unknown[]> {
        const start = Date.now();
        const pages = Array.from({ length: lastPage - 1 }, (_, i) => i + 2);
        const settled = await Promise.allSettled(pages.map(pageNum =>
            page.evaluate(async ({ mangaId, pageNum }) => {
                const res = await fetch(`/api/v1/manga/${mangaId}/recommended?page=${pageNum}`);
                if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
                return res.json();
            }, { mangaId, pageNum })
        ));

        const items: unknown[] = [];
        let failed = 0;
        for (const result of settled) {
            if (result.status === 'fulfilled') {
                const envelope = result.value as Record<string, unknown>;
                const payload = (envelope.result ?? envelope) as Record<string, unknown>;
                const pageItems = payload.items;
                if (Array.isArray(pageItems)) items.push(...pageItems);
            } else {
                failed++;
            }
        }
        console.log(`[navScheduler] recommended-extra ${mangaId} pages=2-${lastPage} items=${items.length} failed=${failed} ${Date.now() - start}ms`);
        return items;
    }

    private parseInitialDataQueryKey(key: string): unknown[] {
        try {
            const parsed = JSON.parse(key) as unknown;
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    private isMangaInitialDataQuery(key: unknown[], mangaId: string): boolean {
        return key[0] === 'manga' && key[2] === mangaId;
    }

    private extractRecommendationPayload(value: unknown): { items: unknown[]; lastPage: number } {
        const envelope = this.asRecord(value);
        const result = this.asRecord(envelope?.result) ?? envelope;
        const rawItems = result?.items ?? value;
        const items = Array.isArray(rawItems) ? rawItems : [];
        const pagination = this.asRecord(result?.pagination) ?? this.asRecord(result?.meta) ?? this.asRecord(envelope?.pagination) ?? this.asRecord(envelope?.meta);
        const rawLastPage = Number(pagination?.lastPage ?? pagination?.last_page ?? 1);
        const lastPage = Number.isFinite(rawLastPage) && rawLastPage > 1 ? Math.floor(rawLastPage) : 1;
        return { items, lastPage };
    }

    private asRecord(value: unknown): Record<string, unknown> | undefined {
        return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    }

    private recommendationId(item: unknown): string {
        if (!item || typeof item !== 'object') return '';
        const raw = item as Record<string, unknown>;
        const id = raw.hid ?? raw.hash_id ?? raw.id;
        return id == null ? '' : String(id);
    }

    private extractInitialDataJson(html: string): string | undefined {
        const scriptStart = html.search(/<script\b[^>]*\bid=["']initial-data["'][^>]*>/i);
        if (scriptStart < 0) return undefined;
        const openEnd = html.indexOf('>', scriptStart);
        if (openEnd < 0) return undefined;
        const contentStart = openEnd + 1;
        const end = html.indexOf('</script>', contentStart);
        if (end < 0) return undefined;
        return html.slice(contentStart, end);
    }

    async destroy(): Promise<void> {
        console.log(`[navScheduler] destroyed cache=${this.sigCache.size} queue=${this.queue.length}`);
    }
}

export class BrowserSession {
    private context: BrowserContext | null = null;
    private fetchPage: Page | null = null;
    private _ready = false;
    private initPromise: Promise<void> | null = null;
    private readonly profileDir: string;
    private readonly scheduler = new NavigationScheduler();
    private readonly mangaDetailCache = new Map<string, MangaDetailCacheEntry>();
    private readonly chapterListCache = new Map<string, ChapterListCacheEntry>();
    private readonly chapterListInflight = new Map<string, Promise<unknown>>();
    private chapterListWarmQueue = new Map<string, true>();
    private chapterListWarmAbort = new Map<string, AbortController>();
    private chapterListWarmActive = 0;
    private readonly chapterDetailCache = new Map<string, ChapterDetailCacheEntry>();
    private readonly chapterDetailInflight = new Map<string, Promise<unknown>>();
    private chapterDetailWarmQueue = new Map<string, ChapterDetailWarmRequest>();
    private chapterDetailWarmActive = false;

    constructor(
        private readonly domain: string,
        private readonly startUrl: string,
    ) {
        this.profileDir = path.join(PROFILE_BASE, `${domain}-session`);
        this.scheduler.setDetailCallback((mangaId, detail) => this.rememberMangaDetail(mangaId, detail));
    }

    get ready(): boolean {
        return this._ready;
    }

    needsSigning(url: string, signingMangaId?: string): boolean {
        return CHAPTER_LIST_PATTERN.test(url) || (!!signingMangaId && CHAPTER_DETAIL_PATTERN.test(url));
    }

    async init(): Promise<void> {
        if (this._ready) return;
        if (this.initPromise) return this.initPromise;
        this.initPromise = this.doInit();
        return this.initPromise;
    }

    private async doInit(): Promise<void> {
        const start = Date.now();
        console.log(`[browserSession] init ${this.domain}`);

        try {
            this.context = await chromium.launchPersistentContext(this.profileDir, {
                executablePath: CLOAKBROWSER_PATH,
                args: STEALTH_ARGS,
                ignoreDefaultArgs: IGNORE_DEFAULT_ARGS,
                headless: false,
                viewport: { width: 1920, height: 1080 },
            });

            this.scheduler.setContext(this.context);

            this.fetchPage = this.context.pages()[0] || await this.context.newPage();
            await this.fetchPage.goto(this.startUrl, { waitUntil: 'networkidle', timeout: 30_000 });

            const cdp = await this.context.newCDPSession(this.fetchPage);
            await cdp.send('Emulation.setScriptExecutionDisabled', { value: true });
            await this.fetchPage.goto(`${this.startUrl}${COMIX_API_BASE_PATH}`, { waitUntil: 'domcontentloaded', timeout: 15_000 });

            console.log(`[browserSession] ready ${this.domain} ${Date.now() - start}ms`);
            this._ready = true;
        } catch (e) {
            this._ready = false;
            this.initPromise = null;
            if (this.context) {
                await this.context.close().catch(() => {});
                this.context = null;
                this.fetchPage = null;
            }
            throw e;
        }
    }

    async signedFetch(fullUrl: string, signingMangaId?: string, signingPageUrl?: string): Promise<BrowserFetchResult> {
        await this.init();

        const request = this.parseSignedRequest(fullUrl, signingMangaId, signingPageUrl);
        const start = Date.now();

        try {
            const data = request.kind === 'chapter-list'
                ? request.page === 1
                    ? await this.fetchWarmChapterListOrPage(request.mangaId)
                    : await this.fetchChapterPageWithSig(request.mangaId, request.page, false)
                : await this.fetchChapterDetailCached(request, 'user');
            const durationMs = Date.now() - start;
            return { data, durationMs };
        } catch (e) {
            const durationMs = Date.now() - start;
            const msg = (e as Error)?.message ?? String(e);
            const target = request.kind === 'chapter-list' ? `page=${request.page}` : `chapter=${request.chapterId}`;
            console.log(`[browserSession] fetch-error ${request.mangaId} ${target} ${durationMs}ms ${msg}`);
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

        await this.scheduler.acquire(mangaId, Priority.USER, true);
        const data = this.getCachedMangaDetail(mangaId);
        if (!data) {
            throw new Error(`No initial manga detail captured for ${mangaId}`);
        }
        return { data, durationMs: Date.now() - start };
    }

    async fetchMangaComments(mangaId: string): Promise<BrowserFetchResult> {
        await this.init();
        const start = Date.now();
        const raw = await this.getMangaDetailRecord(mangaId, true);
        const numericId = this.numericMangaId(raw, `comments ${mangaId}`);
        const pageUrl = typeof raw?.url === 'string' && raw.url.length > 0
            ? raw.url
            : `https://comix.to/title/${mangaId}`;
        const fetched = await this.fetchCommentsForPage(`manga${Math.floor(numericId)}`, pageUrl, pageUrl, `manga-comments ${mangaId}`);
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
        const pageUrl = typeof chapterUrl === 'string' && chapterUrl.length > 0
            ? chapterUrl
            : `https://comix.to/title/${mangaId}/${chapterId}-chapter-${chapterNumber}`;
        const pageIdentifier = `manga${Math.floor(numericId)}_chap${chapterNumber}_vol0`;
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
        if (!detail) {
            await this.scheduler.acquire(mangaId, Priority.USER, forceRefresh);
            detail = this.getCachedMangaDetail(mangaId);
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
        const lookupParams = new URLSearchParams({
            page_identifier: pageIdentifier,
            page_url: pageUrl,
        });
        const lookupUrl = `https://comix.to/api/v1/threads/lookup?${lookupParams}`;
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

        const commentsBaseUrl = `https://comix.to/api/v1/threads/${Math.floor(threadId)}/comments`;
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
                const tree = await proxyFetchJson<Record<string, unknown>>(`https://comix.to/api/v1/comments/${comment.id}`, {
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

    private parseSignedRequest(fullUrl: string, signingMangaId?: string, signingPageUrl?: string): SignedRequest {
        const parsed = new URL(fullUrl);
        const chapterListMatch = parsed.pathname.match(CHAPTER_LIST_PATTERN);
        if (chapterListMatch) {
            const rawPage = Number(parsed.searchParams.get('page') ?? 1);
            const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
            return { kind: 'chapter-list', mangaId: chapterListMatch[1], page };
        }

        const chapterDetailMatch = parsed.pathname.match(CHAPTER_DETAIL_PATTERN);
        if (chapterDetailMatch && signingMangaId) {
            return { kind: 'chapter-detail', mangaId: signingMangaId, chapterId: chapterDetailMatch[1], signingPageUrl };
        }

        throw new Error(`Cannot extract signed request target from ${fullUrl}`);
    }

    prewarmSigs(mangaIds: string[]): void {
        if (!this._ready) return;

        const { queued, skipped } = this.scheduler.submitPrewarm(mangaIds);
        if (queued > 0) {
            console.log(`[browserSession] prewarm queued=${queued} skipped=${skipped} cache=${this.scheduler.cacheSize}`);
        }
    }

    prewarmChapterLists(mangaIds: string[]): { queued: number; skipped: number; cached: number; inflight: number } {
        if (!this._ready) return { queued: 0, skipped: mangaIds.length, cached: 0, inflight: 0 };

        let queued = 0;
        let skipped = 0;
        let cached = 0;
        let inflight = 0;
        const nextQueue = new Map<string, true>();
        const requested = new Set(mangaIds);

        for (const [mangaId, controller] of this.chapterListWarmAbort) {
            if (!requested.has(mangaId)) {
                controller.abort();
                console.log(`[browserSession] chapter-list-warmup abort ${mangaId} reason=not-visible`);
            }
        }

        for (const mangaId of mangaIds) {
            if (this.getCachedChapterList(mangaId)) {
                cached++;
                continue;
            }
            if (this.chapterListInflight.has(mangaId)) {
                inflight++;
                continue;
            }
            if (nextQueue.has(mangaId)) {
                skipped++;
                continue;
            }
            nextQueue.set(mangaId, true);
            queued++;
        }

        this.chapterListWarmQueue = nextQueue;
        console.log(`[browserSession] chapter-list-warmup queued=${queued} skipped=${skipped} cached=${cached} inflight=${inflight} cache=${this.chapterListCache.size}`);
        this.drainChapterListWarmQueue();
        return { queued, skipped, cached, inflight };
    }

    prewarmChapterDetails(requests: ChapterDetailWarmRequest[]): { queued: number; skipped: number } {
        if (!this._ready) return { queued: 0, skipped: requests.length };

        this.chapterDetailWarmQueue.clear();
        let queued = 0;
        let skipped = 0;

        for (const request of requests) {
            const key = this.chapterDetailKey(request.mangaId, request.chapterId);
            if (this.getCachedChapterDetail(key) || this.chapterDetailInflight.has(key)) {
                skipped++;
                continue;
            }
            this.chapterDetailWarmQueue.set(key, request);
            queued++;
        }

        console.log(`[browserSession] chapter-warmup queued=${queued} skipped=${skipped} cache=${this.chapterDetailCache.size}`);
        this.drainChapterDetailWarmQueue();
        return { queued, skipped };
    }

    private drainChapterDetailWarmQueue(): void {
        if (this.chapterDetailWarmActive) return;
        const next = this.chapterDetailWarmQueue.entries().next();
        if (next.done) return;

        const [key, request] = next.value;
        this.chapterDetailWarmQueue.delete(key);
        this.chapterDetailWarmActive = true;

        void this.fetchChapterDetailCached({ kind: 'chapter-detail', ...request }, 'prewarm')
            .catch(err => {
                const msg = (err as Error)?.message ?? String(err);
                console.log(`[browserSession] chapter-warmup failed ${request.mangaId}/${request.chapterId}: ${msg}`);
            })
            .finally(() => {
                this.chapterDetailWarmActive = false;
                this.drainChapterDetailWarmQueue();
            });
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

    private async fetchChapterDetailCached(request: SignedChapterDetailRequest, reason: 'user' | 'prewarm'): Promise<unknown> {
        const key = this.chapterDetailKey(request.mangaId, request.chapterId);
        const cached = this.getCachedChapterDetail(key);
        if (cached) {
            console.log(`[browserSession] chapter-cache hit ${key} reason=${reason}`);
            return cached;
        }

        const inflight = this.chapterDetailInflight.get(key);
        if (inflight) {
            console.log(`[browserSession] chapter-cache join ${key} reason=${reason}`);
            return inflight;
        }

        const promise = this.fetchChapterDetailFromPage(request.mangaId, request.chapterId, request.signingPageUrl, reason)
            .then(data => {
                this.rememberChapterDetail(key, data);
                return data;
            })
            .finally(() => this.chapterDetailInflight.delete(key));

        this.chapterDetailInflight.set(key, promise);
        return promise;
    }

    private getCachedChapterList(mangaId: string): unknown | null {
        const cached = this.chapterListCache.get(mangaId);
        if (!cached) return null;
        if (Date.now() - cached.capturedAt > CHAPTER_LIST_CACHE_TTL_MS) {
            this.chapterListCache.delete(mangaId);
            return null;
        }
        this.chapterListCache.delete(mangaId);
        this.chapterListCache.set(mangaId, cached);
        return cached.data;
    }

    private rememberChapterList(mangaId: string, data: unknown): void {
        this.chapterListCache.set(mangaId, { data, capturedAt: Date.now() });
        while (this.chapterListCache.size > CHAPTER_LIST_CACHE_LIMIT) {
            const oldest = this.chapterListCache.keys().next().value;
            if (!oldest) break;
            this.chapterListCache.delete(oldest);
        }
    }

    private async fetchChapterListCached(mangaId: string, reason: 'user' | 'prewarm', forceRefresh = false, signal?: AbortSignal): Promise<unknown> {
        if (!forceRefresh) {
            const cached = this.getCachedChapterList(mangaId);
            if (cached) {
                console.log(`[browserSession] chapter-list-cache hit ${mangaId} reason=${reason}`);
                return cached;
            }
        }

        const inflight = this.chapterListInflight.get(mangaId);
        if (inflight) {
            console.log(`[browserSession] chapter-list-cache join ${mangaId} reason=${reason}`);
            return inflight;
        }

        const promise = this.fetchAllChapters(mangaId, reason, forceRefresh, signal)
            .then(data => {
                this.rememberChapterList(mangaId, data);
                return data;
            })
            .finally(() => this.chapterListInflight.delete(mangaId));

        this.chapterListInflight.set(mangaId, promise);
        return promise;
    }

    private async fetchWarmChapterListOrPage(mangaId: string): Promise<unknown> {
        const cached = this.getCachedChapterList(mangaId);
        if (cached) {
            console.log(`[browserSession] chapter-list-cache hit ${mangaId} reason=user`);
            return cached;
        }

        const inflight = this.chapterListInflight.get(mangaId);
        if (inflight) {
            const warmup = this.chapterListWarmAbort.get(mangaId);
            if (warmup?.signal.aborted) {
                return this.fetchChapterPageWithSig(mangaId, 1, false);
            }
            console.log(`[browserSession] chapter-list-cache join ${mangaId} reason=user`);
            return inflight;
        }

        return this.fetchChapterPageWithSig(mangaId, 1, false);
    }

    private drainChapterListWarmQueue(): void {
        while (this.chapterListWarmActive < CHAPTER_LIST_WARM_WORKERS) {
            const next = this.chapterListWarmQueue.keys().next();
            if (next.done) return;

            const mangaId = next.value;
            this.chapterListWarmQueue.delete(mangaId);
            this.chapterListWarmActive++;
            const controller = new AbortController();
            this.chapterListWarmAbort.set(mangaId, controller);

            void this.fetchChapterListCached(mangaId, 'prewarm', false, controller.signal)
                .catch(err => {
                    if (controller.signal.aborted) return;
                    const msg = (err as Error)?.message ?? String(err);
                    console.log(`[browserSession] chapter-list-warmup failed ${mangaId}: ${msg}`);
                })
                .finally(() => {
                    this.chapterListWarmAbort.delete(mangaId);
                    this.chapterListWarmActive--;
                    this.drainChapterListWarmQueue();
                });
        }
    }

    private async fetchAllChapters(mangaId: string, reason: 'user' | 'prewarm', forceRefresh: boolean, signal?: AbortSignal): Promise<unknown> {
        try {
            return await this.fetchAllChaptersWithSig(mangaId, reason, forceRefresh, signal);
        } catch (e) {
            if (!isSignedApiRejected(e)) {
                throw e;
            }

            const msg = (e as Error)?.message ?? String(e);
            this.scheduler.invalidate(mangaId, 'signed-api-rejected');
            console.log(`[browserSession] chapters ${mangaId} signed-api-rejected retrying: ${msg}`);
            return this.fetchAllChaptersWithSig(mangaId, reason, true, signal);
        }
    }

    private async fetchChapterPageWithSig(mangaId: string, page: number, forceRefresh: boolean): Promise<unknown> {
        const t0 = Date.now();
        const cachedBefore = !forceRefresh && !!this.scheduler.getCachedSig(mangaId);
        const sig = await this.scheduler.acquire(mangaId, Priority.USER, forceRefresh);
        const sigMs = Date.now() - t0;
        const sigSource = forceRefresh ? 'refresh' : (cachedBefore ? 'cache' : (sigMs < 5 ? 'cache' : 'nav'));

        try {
            const t1 = Date.now();
            const data = await this.fetchChapterPage(mangaId, sig, page);
            const pageMs = Date.now() - t1;
            const pagination = data?.result?.pagination ?? data?.result?.meta;
            const items = data?.result?.items ?? [];
            const currentPage = pagination?.current_page ?? pagination?.page ?? page;
            const lastPage = pagination?.last_page ?? pagination?.lastPage ?? '?';
            const total = pagination?.total ?? items.length;
            console.log(`[browserSession] chapters ${mangaId} sig=${sigSource}:${sigMs}ms page=${currentPage}/${lastPage} items=${items.length} total=${total} ${pageMs}ms`);
            return data;
        } catch (e) {
            if (!forceRefresh && isSignedApiRejected(e)) {
                const msg = (e as Error)?.message ?? String(e);
                this.scheduler.invalidate(mangaId, 'signed-api-rejected');
                console.log(`[browserSession] chapters ${mangaId} page=${page} signed-api-rejected retrying: ${msg}`);
                return this.fetchChapterPageWithSig(mangaId, page, true);
            }
            throw e;
        }
    }

    private async fetchChapterDetailFromPage(mangaId: string, chapterId: string, signingPageUrl: string | undefined, reason: 'user' | 'prewarm'): Promise<unknown> {
        if (!signingPageUrl) {
            throw new Error(`Missing signingPageUrl for chapter ${chapterId}`);
        }

        const page = await this.context!.newPage();
        const t0 = Date.now();
        try {
            const dataPromise = new Promise<unknown>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    page.off('response', handler);
                    reject(new Error(`Timed out waiting for signed chapter detail ${chapterId}`));
                }, 15_000);

                const handler = async (res: import('playwright').Response) => {
                    const url = res.url();
                    if (!url.includes(`${COMIX_API_BASE_PATH}/chapters/${chapterId}`) || !url.includes('_=')) return;

                    clearTimeout(timeout);
                    page.off('response', handler);
                    try {
                        if (!res.ok()) {
                            reject(new Error(`HTTP ${res.status()} ${res.statusText()}`));
                            return;
                        }
                        resolve(assertJsonEnvelopeOk(await res.json()));
                    } catch (e) {
                        reject(e);
                    }
                };

                page.on('response', handler);
            });

            await page.goto(signingPageUrl, { waitUntil: 'commit', timeout: 15_000 });
            const data = await dataPromise;
            const pages = (data as any)?.result?.pages ?? [];
            console.log(`[browserSession] chapter ${mangaId}/${chapterId} page-load reason=${reason} pages=${pages.length} ${Date.now() - t0}ms`);
            return data;
        } finally {
            await page.close().catch(e => {
                console.log(`[browserSession] chapter page-close failed ${mangaId}/${chapterId}: ${(e as Error)?.message ?? e}`);
            });
        }
    }

    private async fetchAllChaptersWithSig(mangaId: string, reason: 'user' | 'prewarm', forceRefresh: boolean, signal?: AbortSignal): Promise<unknown> {
        if (signal?.aborted) throw new Error('Warmup aborted');
        const t0 = Date.now();
        const cachedBefore = !forceRefresh && !!this.scheduler.getCachedSig(mangaId);
        const sig = await this.scheduler.acquire(mangaId, reason === 'user' ? Priority.USER : Priority.PREWARM, forceRefresh);
        if (signal?.aborted) throw new Error('Warmup aborted');
        const sigMs = Date.now() - t0;
        const sigSource = forceRefresh ? 'refresh' : (cachedBefore ? 'cache' : (sigMs < 5 ? 'cache' : 'nav'));

        const t1 = Date.now();
        const page1 = await this.fetchChapterPage(mangaId, sig, 1);
        if (signal?.aborted) throw new Error('Warmup aborted');
        const p1Ms = Date.now() - t1;
        const pagination = page1?.result?.pagination ?? page1?.result?.meta;
        const lastPage = pagination?.last_page ?? pagination?.lastPage ?? 1;
        const page1Items = page1?.result?.items ?? [];

        if (lastPage <= 1) {
            console.log(`[browserSession] chapters ${mangaId} reason=${reason} sig=${sigSource}:${sigMs}ms p1=${p1Ms}ms items=${page1Items.length} total=${pagination?.total ?? page1Items.length}`);
            return page1;
        }

        console.log(`[browserSession] chapters ${mangaId} reason=${reason} sig=${sigSource}:${sigMs}ms p1=${p1Ms}ms page=1/${lastPage} items=${page1Items.length} total=${pagination?.total ?? '?'} fetching remaining`);

        const t2 = Date.now();
        const pageNums = Array.from({ length: lastPage - 1 }, (_, i) => i + 2);
        const results: PromiseSettledResult<any>[] = [];
        const width = 6;
        for (let i = 0; i < pageNums.length; i += width) {
            if (signal?.aborted) throw new Error('Warmup aborted');
            const batch = pageNums.slice(i, i + width);
            results.push(...await Promise.allSettled(
                batch.map(p => this.fetchChapterPage(mangaId, sig, p)),
            ));
        }
        if (signal?.aborted) throw new Error('Warmup aborted');

        const allItems = [...page1Items];
        let failed = 0;
        let signedApiRejected: unknown = null;
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const p = pageNums[i];
            if (r.status === 'fulfilled') {
                const items = r.value?.result?.items ?? [];
                if (items.length > 0) {
                    allItems.push(...items);
                } else {
                    failed++;
                    console.log(`[browserSession] chapters ${mangaId} page=${p}/${lastPage} items=0`);
                }
            } else {
                if (isSignedApiRejected(r.reason)) {
                    signedApiRejected = r.reason;
                }
                failed++;
                console.log(`[browserSession] chapters ${mangaId} page=${p}/${lastPage} error: ${r.reason?.message}`);
            }
        }
        const pNMs = Date.now() - t2;

        if (signedApiRejected) {
            console.log(`[browserSession] chapters ${mangaId} signed-api-rejected during page fanout fetched=${allItems.length} failed=${failed}`);
            throw signedApiRejected;
        }

        console.log(`[browserSession] chapters ${mangaId} done reason=${reason} sig=${sigSource}:${sigMs}ms p1=${p1Ms}ms p2-${lastPage}=${pNMs}ms fetched=${allItems.length} failed=${failed}`);

        return {
            status: 200,
            result: {
                items: allItems,
                pagination: {
                    ...pagination,
                    current_page: 1,
                    last_page: 1,
                    total: allItems.length,
                    count: allItems.length,
                },
            },
        };
    }

    private async fetchChapterPage(mangaId: string, sig: string, pageNum: number): Promise<any> {
        const data = await this.fetchPage!.evaluate(
            async ({ apiBasePath, mangaId, sig, pageNum }) => {
                const url = `${apiBasePath}/manga/${mangaId}/chapters?limit=100&page=${pageNum}&order%5Bnumber%5D=desc&time=1&_=${sig}`;
                const res = await fetch(url);
                if (!res.ok) {
                    throw new Error(`HTTP ${res.status} ${res.statusText}`);
                }
                return res.json();
            },
            { apiBasePath: COMIX_API_BASE_PATH, mangaId, sig, pageNum },
        );
        return assertJsonEnvelopeOk(data);
    }

    async destroy(): Promise<void> {
        this._ready = false;
        await this.scheduler.destroy();
        if (this.context) {
            await this.context.close().catch(() => {});
            this.context = null;
            this.fetchPage = null;
            this.initPromise = null;
            console.log(`[browserSession] destroyed ${this.domain}`);
        }
    }
}
