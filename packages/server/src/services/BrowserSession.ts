import { chromium, type BrowserContext, type Page } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import { assertJsonEnvelopeOk, UpstreamBodyError } from '../utils/proxyFetch.js';

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

export interface BrowserFetchResult {
    data: unknown;
    durationMs: number;
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
        for (const [key, value] of Object.entries(queries)) {
            if (key.includes('"manga"') && key.includes('"detail"') && key.includes(`"${mangaId}"`)) {
                console.log(`[navScheduler] initial-detail-breakdown ${mangaId} source=document response=${responseMs}ms text=${textMs}ms extract=${extractMs}ms parse=${Date.now() - parseStart}ms bytes=${raw.length}`);
                return { status: 'ok', result: value };
            }
        }
        console.log(`[navScheduler] initial-detail-breakdown ${mangaId} source=document response=${responseMs}ms text=${textMs}ms extract=${extractMs}ms parse=${Date.now() - parseStart}ms bytes=${raw.length} missing-query`);
        return undefined;
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
