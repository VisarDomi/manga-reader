import { chromium, type BrowserContext, type Page } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import type { RuntimeByteResult, ServerMangaProvider } from '../providers/types.js';
import { ScrambledPageDecoder, type ScrambledPageDecodeRequest } from './ScrambledPageDecoder.js';

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
const BROWSER_SURFACE_LOG_MS = 60_000;
const BROWSER_INIT_TIMEOUT_MS = 30_000;
type RuntimeHttpLane = 'foreground' | 'background';

export interface BrowserFetchResult {
    data: unknown;
    durationMs: number;
}

export interface BrowserDocumentResult {
    html: string;
    durationMs: number;
}

export interface BrowserInteractiveDocumentResult extends BrowserDocumentResult {
    responses: Array<{ url: string; status: number; contentType: string; body: string }>;
    buttons: string[];
}

export interface BrowserFetchContext {
    owner?: string;
    priority?: string;
    reason?: string;
}

export interface BrowserDecodeResult {
    buffer: Buffer;
    contentType: 'image/png';
    durationMs: number;
}

function browserFetchContextLog(context: BrowserFetchContext): string {
    return `owner=${context.owner ?? 'direct'} priority=${context.priority ?? 'unknown'} reason=${context.reason ?? 'unspecified'}`;
}

function shouldLogFetchContext(context: BrowserFetchContext): boolean {
    return context.priority === 'interactive' || context.priority === 'foreground' || context.priority === 'observed';
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
    private readonly runtimeHttpPages = new Map<RuntimeHttpLane, Page>();
    private readonly runtimeHttpReady = new Map<RuntimeHttpLane, boolean>();
    private readonly runtimeHttpInit = new Map<RuntimeHttpLane, Promise<void>>();
    private readonly runtimeLaneLocks = new Map<RuntimeHttpLane, Promise<unknown>>();
    private runtimeHttpHealthy = true;
    private _ready = false;
    private initPromise: Promise<void> | null = null;
    private readonly profileDir: string;
    private readonly mangaDetailCache = new Map<string, MangaDetailCacheEntry>();
    private readonly chapterPageCache = new Map<string, ChapterListCacheEntry>();
    private readonly chapterPageInflight = new Map<string, Promise<unknown>>();
    private readonly chapterDetailCache = new Map<string, ChapterDetailCacheEntry>();
    private readonly chapterDetailInflight = new Map<string, Promise<unknown>>();
    private readonly runtimeApiInflight = new Map<string, Promise<unknown>>();
    private decoder: ScrambledPageDecoder | null = null;
    private surfaceLogTimer: NodeJS.Timeout | null = null;

    constructor(
        private readonly provider: ServerMangaProvider,
    ) {
        this.profileDir = provider.browserProfileDir ?? path.join(PROFILE_BASE, `${provider.domain}-session`);
    }

    get ready(): boolean {
        return this._ready;
    }

    canRunBackgroundRuntimeWork(): boolean {
        return this.runtimeHttpHealthy;
    }

    canServeRuntimeRequests(): boolean {
        if (!this._ready || !this.runtimeHttpHealthy) return false;
        return this.provider.runtimeProbeMangaId
            ? this.runtimeHttpReady.get('foreground') === true
            : true;
    }

    async init(): Promise<void> {
        if (this._ready && this.context) return;
        if (this._ready && !this.context) {
            this._ready = false;
            this.resetRuntimeHttpState();
            this.decoder = null;
        }
        if (this.initPromise) return this.initPromise;
        this.initPromise = this.doInit();
        return this.initPromise;
    }

    private async doInit(): Promise<void> {
        const start = Date.now();
        console.log(`[browserSession] init ${this.provider.domain}`);

        try {
            this.context = await chromium.launchPersistentContext(this.profileDir, {
                executablePath: this.provider.browserExecutablePath ?? CLOAKBROWSER_PATH,
                args: STEALTH_ARGS,
                ignoreDefaultArgs: IGNORE_DEFAULT_ARGS,
                headless: false,
                viewport: { width: 1920, height: 1080 },
                timeout: this.provider.browserInitTimeoutMs ?? BROWSER_INIT_TIMEOUT_MS,
            });
            await this.claimStartupPage();
            this.decoder = new ScrambledPageDecoder(this.context, this.provider);

            this._ready = true;
            console.log(`[browserSession] ready ${this.provider.domain} ${Date.now() - start}ms`);
            this.startBrowserSurfaceLog();
        } catch (e) {
            this._ready = false;
            this.initPromise = null;
            if (this.context) {
                await this.context.close().catch(() => {});
                this.context = null;
                this.resetRuntimeHttpState();
                this.decoder = null;
            }
            throw e;
        }
    }

    private async claimStartupPage(): Promise<void> {
        if (!this.context) return;
        const pages = this.context.pages().filter(page => !page.isClosed());
        if (pages.length === 0) return;

        const start = Date.now();
        const [owned, ...orphans] = pages;
        this.runtimeHttpPages.set('foreground', owned);
        this.runtimeHttpReady.set('foreground', false);
        const results = await Promise.allSettled(orphans.map(page => page.close()));
        const failed = results.filter(result => result.status === 'rejected').length;
        console.log(`[browserSession] startup-pages-adopted kept=1 closed=${orphans.length} failed=${failed} ${Date.now() - start}ms`);
    }

    async warmRuntimeHttp(reason: string): Promise<void> {
        await this.init();
        const start = Date.now();
        const probeMangaId = this.provider.runtimeProbeMangaId ?? '';
        if (!probeMangaId) {
            console.log(`[browserSession] runtime-http warm-skipped provider=${this.provider.id} reason=${reason} noProbeManga=1`);
            return;
        }
        const lanes: RuntimeHttpLane[] = ['foreground', 'background'];
        const results = await Promise.allSettled(lanes.map(lane => this.ensureRuntimeHttpPage(probeMangaId, lane)));
        const failed = results.filter(result => result.status === 'rejected').length;
        if (failed > 0) {
            const firstError = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')?.reason;
            const msg = this.errorMessage(firstError);
            this.markRuntimeUnhealthy(msg);
            throw new Error(`${this.provider.name} runtime warm failed lanes=${failed}/${lanes.length}: ${msg}`);
        }
        console.log(`[browserSession] runtime-http warm provider=${this.provider.id} reason=${reason} lanes=${lanes.length} ${Date.now() - start}ms`);
    }

    async fetchMangaDetail(mangaId: string, context: BrowserFetchContext = {}): Promise<BrowserFetchResult> {
        await this.init();
        const start = Date.now();
        const cached = this.getCachedMangaDetail(mangaId);
        if (cached) {
            console.log(`[browserSession] manga-detail-cache hit ${mangaId}`);
            return { data: cached, durationMs: Date.now() - start };
        }

        let data: unknown;
        try {
            data = await this.fetchMangaDetailViaRuntimeHttp(mangaId, context);
        } catch (e) {
            if (!this.isClosedContextError(e)) throw e;
            console.log(`[browserSession] context-recover provider=${this.provider.id} owner=manga-detail reason=${this.errorMessage(e)}`);
            await this.resetBrowserContext('manga-detail-closed-context');
            await this.init();
            data = await this.fetchMangaDetailViaRuntimeHttp(mangaId, context);
        }
        this.rememberMangaDetail(mangaId, data);
        return { data, durationMs: Date.now() - start };
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

    async fetchChapterListPage(mangaId: string, page: number, pageSize = CHAPTER_LIST_PAGE_SIZE, context: BrowserFetchContext = {}): Promise<BrowserFetchResult> {
        await this.init();
        const start = Date.now();
        try {
            const data = await this.fetchChapterPageViaRuntimeHttp(mangaId, page, pageSize, context);
            return { data, durationMs: Date.now() - start };
        } catch (e) {
            if (this.isClosedContextError(e)) {
                console.log(`[browserSession] context-recover provider=${this.provider.id} owner=chapter-list reason=${this.errorMessage(e)}`);
                await this.resetBrowserContext('chapter-list-closed-context');
                await this.init();
                const data = await this.fetchChapterPageViaRuntimeHttp(mangaId, page, pageSize, context);
                return { data, durationMs: Date.now() - start };
            }
            const durationMs = Date.now() - start;
            const msg = (e as Error)?.message ?? String(e);
            console.log(`[browserSession] fetch-error ${mangaId} page=${page} ${durationMs}ms ${msg}`);
            throw e;
        }
    }

    async fetchChapterImages(mangaId: string, chapterId: string, chapterNumber?: number, chapterUrl?: string, context: BrowserFetchContext = {}): Promise<BrowserFetchResult> {
        await this.init();
        const start = Date.now();
        try {
            const data = await this.fetchChapterDetailCached(mangaId, chapterId, chapterNumber, chapterUrl, context);
            return { data, durationMs: Date.now() - start };
        } catch (e) {
            if (this.isClosedContextError(e)) {
                console.log(`[browserSession] context-recover provider=${this.provider.id} owner=${context.owner ?? 'direct'} reason=${this.errorMessage(e)}`);
                await this.resetBrowserContext('closed-context');
                await this.init();
                const data = await this.fetchChapterDetailCached(mangaId, chapterId, chapterNumber, chapterUrl, context);
                return { data, durationMs: Date.now() - start };
            }
            const durationMs = Date.now() - start;
            const msg = this.errorMessage(e);
            if (shouldLogFetchContext(context)) {
                console.log(`[browserSession] fetch-error ${mangaId} chapter=${chapterId} ${browserFetchContextLog(context)} ${durationMs}ms ${msg}`);
            }
            throw e;
        }
    }

    async fetchRuntimeApi(apiUrlOrPath: string, context: BrowserFetchContext = {}): Promise<BrowserFetchResult> {
        await this.init();
        const start = Date.now();
        const probeMangaId = this.provider.runtimeProbeMangaId ?? '';
        const apiPath = this.pathForRuntimeFetch(apiUrlOrPath);
        const data = await this.runtimeHttpGet<unknown>(probeMangaId, apiPath, undefined, context);
        console.log(`[browserSession] runtime-api provider=${this.provider.id} path=${apiPath} ${browserFetchContextLog(context)} ${Date.now() - start}ms`);
        return { data, durationMs: Date.now() - start };
    }

    async fetchRuntimeDocument(urlOrPath: string, context: BrowserFetchContext = {}): Promise<BrowserDocumentResult> {
        const lane = this.runtimeHttpLane(context);
        return this.runInRuntimeLane(lane, async () => {
            await this.init();
            const start = Date.now();
            const probeMangaId = this.provider.runtimeProbeMangaId ?? '';
            const page = await this.ensureRuntimeHttpPage(probeMangaId, lane);
            const url = this.provider.absoluteUrl(urlOrPath);
            const timeoutMs = this.runtimeRequestTimeoutMs(context);
            try {
                const html = await page.evaluate(async ({ url, timeoutMs }) => {
                    const controller = timeoutMs > 0 ? new AbortController() : null;
                    const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
                    try {
                        const response = await fetch(url, { credentials: 'include', signal: controller?.signal });
                        const text = await response.text();
                        if (!response.ok) {
                            throw new Error(`Provider runtime document http=${response.status} url=${url} body=${text.slice(0, 160)}`);
                        }
                        return text;
                    } finally {
                        if (timeout) clearTimeout(timeout);
                    }
                }, { url, timeoutMs });
                this.markRuntimeHealthy();
                console.log(`[browserSession] runtime-document provider=${this.provider.id} lane=${lane} url=${url} ${browserFetchContextLog(context)} bytes=${html.length} ${Date.now() - start}ms`);
                return { html, durationMs: Date.now() - start };
            } catch (error) {
                if (this.isProviderChallengeError(error)) this.markRuntimeUnhealthy(this.errorMessage(error));
                throw error;
            }
        });
    }

    async fetchInteractiveDocument(urlOrPath: string, context: BrowserFetchContext = {}): Promise<BrowserInteractiveDocumentResult> {
        await this.init();
        const start = Date.now();
        const url = this.provider.absoluteUrl(urlOrPath);
        const page = await this.context!.newPage();
        const responses: BrowserInteractiveDocumentResult['responses'] = [];
        page.on('response', response => {
            const responseUrl = response.url();
            if (!/comment|\/api\//i.test(responseUrl)) return;
            void (async () => {
                let body = '';
                try {
                    body = (await response.text()).slice(0, 20_000);
                } catch {
                    body = '';
                }
                responses.push({
                    url: responseUrl,
                    status: response.status(),
                    contentType: response.headers()['content-type'] ?? '',
                    body,
                });
            })();
        });
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.provider.runtimePageTimeoutMs ?? 15_000 });
            await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
            const buttons = await page.evaluate(() => {
                return [...document.querySelectorAll('button')]
                    .map(button => (button.textContent ?? button.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim())
                    .filter(Boolean)
                    .slice(0, 40);
            });
            const clicked = await page.evaluate(() => {
                const buttons = [...document.querySelectorAll('button')] as HTMLButtonElement[];
                const scored = buttons
                    .map(button => {
                        const text = (button.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
                        const label = (button.getAttribute('aria-label') ?? '').toLowerCase();
                        const title = (button.getAttribute('title') ?? '').toLowerCase();
                        const className = String(button.className ?? '').toLowerCase();
                        const score = [
                            text.includes('comment') ? 100 : 0,
                            label.includes('comment') ? 100 : 0,
                            title.includes('comment') ? 100 : 0,
                            className.includes('comment') ? 80 : 0,
                            /^\d+$/.test(text) ? 20 : 0,
                        ].reduce((sum, item) => sum + item, 0);
                        return { button, score, text: text || label || title || className };
                    })
                    .filter(item => item.score > 0)
                    .sort((a, b) => b.score - a.score);
                const winner = scored[0];
                if (!winner) return { clicked: false, label: '' };
                winner.button.click();
                return { clicked: true, label: winner.text };
            });
            if (clicked.clicked) {
                await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
                await page.waitForTimeout(500);
            }
            const html = await page.content();
            await page.close().catch(() => {});
            console.log(`[browserSession] interactive-document provider=${this.provider.id} url=${url} ${browserFetchContextLog(context)} clicked=${clicked.clicked ? clicked.label : 'none'} buttons=${buttons.length} responses=${responses.length} bytes=${html.length} ${Date.now() - start}ms`);
            return { html, responses, buttons, durationMs: Date.now() - start };
        } catch (error) {
            await page.close().catch(() => {});
            console.log(`[browserSession] interactive-document failed provider=${this.provider.id} url=${url} ${browserFetchContextLog(context)} ${Date.now() - start}ms ${this.errorMessage(error)}`);
            throw error;
        }
    }

    async fetchRuntimeByte(url: string, context: BrowserFetchContext = {}): Promise<RuntimeByteResult> {
        const lane = this.runtimeHttpLane(context);
        return this.runInRuntimeLane(lane, async () => {
            await this.init();
            const start = Date.now();
            const probeMangaId = this.provider.runtimeProbeMangaId ?? '';
            const page = await this.ensureRuntimeHttpPage(probeMangaId, lane);
            const timeoutMs = this.runtimeRequestTimeoutMs(context);
            const result = await page.evaluate(async ({ url, timeoutMs }) => {
                const controller = timeoutMs > 0 ? new AbortController() : null;
                const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
                try {
                    const response = await fetch(url, { credentials: 'include', signal: controller?.signal });
                    const buffer = await response.arrayBuffer();
                    return {
                        status: response.status,
                        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
                        bytes: Array.from(new Uint8Array(buffer)),
                    };
                } finally {
                    if (timeout) clearTimeout(timeout);
                }
            }, { url: this.provider.absoluteUrl(url), timeoutMs });
            if (result.status < 200 || result.status >= 300) {
                const error = new Error(`${this.provider.name} runtime byte fetch http=${result.status} url=${url}`);
                if (this.isProviderChallengeStatus(result.status)) this.markRuntimeUnhealthy(error.message);
                throw error;
            }
            this.markRuntimeHealthy();
            console.log(`[browserSession] runtime-byte provider=${this.provider.id} lane=${lane} url=${url} ${browserFetchContextLog(context)} bytes=${result.bytes.length} ${Date.now() - start}ms`);
            return {
                status: result.status,
                contentType: result.contentType,
                buffer: Buffer.from(result.bytes),
            };
        });
    }

    private pathForRuntimeFetch(apiUrlOrPath: string): string {
        if (!apiUrlOrPath.startsWith('http')) return apiUrlOrPath;
        const url = new URL(apiUrlOrPath);
        return `${url.pathname}${url.search}`;
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

    private async fetchChapterDetailCached(mangaId: string, chapterId: string, chapterNumber?: number, chapterUrl?: string, context: BrowserFetchContext = {}): Promise<unknown> {
        const key = this.chapterDetailKey(mangaId, chapterId);
        const cached = this.getCachedChapterDetail(key);
        if (cached) {
            console.log(`[browserSession] chapter-cache hit ${key} ${browserFetchContextLog(context)}`);
            return cached;
        }

        const inflight = this.chapterDetailInflight.get(key);
        if (inflight) {
            console.log(`[browserSession] chapter-cache join ${key} ${browserFetchContextLog(context)}`);
            return inflight;
        }

        const promise = this.fetchChapterDetailViaRuntimeHttp(mangaId, chapterId, chapterNumber, chapterUrl, context)
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

    private async fetchChapterDetailViaRuntimeHttp(mangaId: string, chapterId: string, chapterNumber?: number, chapterUrl?: string, context: BrowserFetchContext = {}): Promise<unknown> {
        const t0 = Date.now();
        const detail = await this.runtimeHttpGet<Record<string, unknown>>(mangaId, this.provider.chapterImagesPath(chapterId), undefined, context);
        const normalized = this.provider.normalizeChapterImages(detail);
        const data = {
            status: 'ok',
            result: {
                source: normalized.source,
                schemaVersion: normalized.schemaVersion,
                targetCount: normalized.targetCount,
                chapterNumber,
                chapterUrl,
                pages: normalized.pages,
            },
        };
        if (normalized.pages.length === 0 || normalized.pages.length !== normalized.targetCount) {
            if (shouldLogFetchContext(context)) {
                console.log(`[browserSession] chapter ${mangaId}/${chapterId} page-load ${browserFetchContextLog(context)} source=${normalized.source}-incomplete pages=${normalized.pages.length} targetCount=${normalized.targetCount} ${Date.now() - t0}ms`);
            }
            throw new Error(`Runtime HTTP returned incomplete chapter images for ${mangaId}/${chapterId}: pages=${normalized.pages.length} targetCount=${normalized.targetCount}`);
        }
        const scrambled = normalized.pages.filter(page => page.scramble).length;
        if (shouldLogFetchContext(context)) {
            console.log(`[browserSession] chapter ${mangaId}/${chapterId} page-load ${browserFetchContextLog(context)} source=${normalized.source} schema=${normalized.schemaVersion} pages=${normalized.pages.length} targetCount=${normalized.targetCount} scrambled=${scrambled} ${Date.now() - t0}ms`);
        }
        return data;
    }

    async decodeScrambledPage(request: ScrambledPageDecodeRequest): Promise<BrowserDecodeResult> {
        await this.init();
        if (!this.decoder) {
            if (!this.context) throw new Error('Browser context unavailable for scrambled page decoder');
            this.decoder = new ScrambledPageDecoder(this.context, this.provider);
        }
        return this.decoder.decode(request);
    }

    hasCriticalScrambledPageWork(): boolean {
        return this.decoder?.hasCriticalWork() ?? false;
    }

    warmScrambledPageDecoder(mangaId: string): void {
        if (!this.decoder || !this._ready) return;
        this.decoder.warm(mangaId);
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

    private async ensureRuntimeHttpPage(mangaId: string, lane: RuntimeHttpLane): Promise<Page> {
        const existing = this.runtimeHttpPages.get(lane);
        if (existing && !existing.isClosed() && this.runtimeHttpReady.get(lane) === true) return existing;
        if (!this.runtimeHttpInit.has(lane)) {
            const init = this.createRuntimeHttpPage(mangaId, lane).finally(() => {
                this.runtimeHttpInit.delete(lane);
            });
            this.runtimeHttpInit.set(lane, init);
        }
        await this.runtimeHttpInit.get(lane);
        const page = this.runtimeHttpPages.get(lane);
        if (!page || page.isClosed()) {
            throw new Error(`${this.provider.name} runtime HTTP page unavailable lane=${lane}`);
        }
        return page;
    }

    private async createRuntimeHttpPage(mangaId: string, lane: RuntimeHttpLane): Promise<void> {
        const start = Date.now();
        let page: Page | null = this.runtimeHttpPages.get(lane) && !this.runtimeHttpPages.get(lane)!.isClosed()
            ? this.runtimeHttpPages.get(lane)!
            : null;

        if (!page) {
            page = await this.context!.newPage();
        }

        try {
            this.runtimeHttpReady.set(lane, false);
            await page.goto(this.provider.runtimePageUrl(mangaId), { waitUntil: 'domcontentloaded', timeout: this.provider.runtimePageTimeoutMs ?? 15_000 });
            await this.provider.resolveRuntimeHttpClient(page, mangaId, `browserSession:${lane}`);
            this.runtimeHttpPages.set(lane, page);
            this.runtimeHttpReady.set(lane, true);
            this.runtimeHttpHealthy = true;
            console.log(`[browserSession] runtime-http ready provider=${this.provider.id} lane=${lane} manga=${mangaId} ${Date.now() - start}ms`);
        } catch (error) {
            if (this.runtimeHttpPages.get(lane) === page) {
                this.runtimeHttpPages.delete(lane);
            }
            this.runtimeHttpReady.set(lane, false);
            const msg = (error as Error)?.message ?? String(error);
            const openPages = this.context?.pages().filter(candidate => !candidate.isClosed()).length ?? 0;
            if (openPages > 1) {
                await page.close().catch(closeError => {
                    console.log(`[browserSession] runtime-http init-page-close failed manga=${mangaId}: ${(closeError as Error)?.message ?? closeError}`);
                });
            } else {
                console.log(`[browserSession] runtime-http init-page-kept provider=${this.provider.id} lane=${lane} manga=${mangaId} reason=last-context-page`);
            }
            this.runtimeHttpHealthy = false;
            console.log(`[browserSession] runtime-http init-failed provider=${this.provider.id} lane=${lane} manga=${mangaId} ${Date.now() - start}ms ${msg}`);
            throw error;
        }
    }

    private async resetRuntimeHttpPage(reason: string, lane?: RuntimeHttpLane): Promise<void> {
        const lanes: RuntimeHttpLane[] = lane ? [lane] : ['foreground', 'background'];
        for (const targetLane of lanes) {
            const page = this.runtimeHttpPages.get(targetLane);
            this.runtimeHttpPages.delete(targetLane);
            this.runtimeHttpReady.set(targetLane, false);
            this.runtimeHttpInit.delete(targetLane);
            if (page && !page.isClosed()) {
                await page.close().catch(e => {
                    console.log(`[browserSession] runtime-http page-close failed lane=${targetLane} reason=${reason}: ${(e as Error)?.message ?? e}`);
                });
            }
        }
    }

    private resetRuntimeHttpState(): void {
        this.runtimeHttpPages.clear();
        this.runtimeHttpReady.clear();
        this.runtimeHttpInit.clear();
        this.runtimeLaneLocks.clear();
    }

    private runtimeHttpLane(context: BrowserFetchContext = {}): RuntimeHttpLane {
        return context.priority === 'interactive' || context.priority === 'foreground'
            ? 'foreground'
            : 'background';
    }

    private async resetBrowserContext(reason: string): Promise<void> {
        this._ready = false;
        this.initPromise = null;
        this.resetRuntimeHttpState();
        await this.decoder?.destroy().catch(() => {});
        this.decoder = null;
        const context = this.context;
        this.context = null;
        if (context) {
            await context.close().catch(e => {
                console.log(`[browserSession] context-close failed provider=${this.provider.id} reason=${reason}: ${this.errorMessage(e)}`);
            });
        }
        console.log(`[browserSession] context-reset provider=${this.provider.id} reason=${reason}`);
    }

    private isClosedContextError(error: unknown): boolean {
        const msg = this.errorMessage(error);
        return msg.includes('Target page, context or browser has been closed')
            || msg.includes('browserContext.newPage')
            || msg.includes('Context closed')
            || msg.includes('Failed to open a new tab');
    }

    private errorMessage(error: unknown): string {
        return (error as Error)?.message ?? String(error);
    }

    private async runtimeHttpGet<T>(mangaId: string, apiPath: string, params?: Record<string, unknown>, context: BrowserFetchContext = {}, attempt = 1): Promise<T> {
        const lane = this.runtimeHttpLane(context);
        const key = this.runtimeApiKey(lane, mangaId, apiPath, params);
        const inflight = this.runtimeApiInflight.get(key);
        if (inflight) {
            console.log(`[browserSession] runtime-http join provider=${this.provider.id} lane=${lane} manga=${mangaId} path=${apiPath}`);
            return inflight as Promise<T>;
        }
        const promise = this.runtimeHttpGetOwned<T>(mangaId, apiPath, params, context, attempt)
            .finally(() => this.runtimeApiInflight.delete(key));
        promise.catch(() => undefined);
        this.runtimeApiInflight.set(key, promise);
        return promise;
    }

    private runtimeApiKey(lane: RuntimeHttpLane, mangaId: string, apiPath: string, params?: Record<string, unknown>): string {
        return `${lane}:${mangaId}:${apiPath}:${JSON.stringify(params ?? {})}`;
    }

    private async runtimeHttpGetOwned<T>(mangaId: string, apiPath: string, params?: Record<string, unknown>, context: BrowserFetchContext = {}, attempt = 1): Promise<T> {
        const lane = this.runtimeHttpLane(context);
        return this.runInRuntimeLane(lane, () => this.runtimeHttpGetOwnedLocked<T>(mangaId, apiPath, params, context, attempt));
    }

    private async runtimeHttpGetOwnedLocked<T>(mangaId: string, apiPath: string, params?: Record<string, unknown>, context: BrowserFetchContext = {}, attempt = 1): Promise<T> {
        const lane = this.runtimeHttpLane(context);
        const page = await this.ensureRuntimeHttpPage(mangaId, lane);
        try {
            const value = await page.evaluate(
                async ({ apiPath, params, timeoutMs }) => {
                    const http = (globalThis as any).__providerRuntimeHttp;
                    if (!http?.get) throw new Error('Provider runtime HTTP client unavailable');
                    return http.get(apiPath, { ...(params ? { params } : {}), timeoutMs });
                },
                { apiPath, params, timeoutMs: this.provider.id === 'mangadotnet' ? this.runtimeRequestTimeoutMs(context) : undefined },
            ) as T;
            this.markRuntimeHealthy();
            return value;
        } catch (e) {
            const msg = this.errorMessage(e);
            if (!this.shouldResetRuntimeHttp(e)) {
                if (this.isProviderChallengeError(e)) this.markRuntimeUnhealthy(msg);
                console.log(`[browserSession] runtime-http request-failed provider=${this.provider.id} lane=${lane} manga=${mangaId} path=${apiPath} ${browserFetchContextLog(context)} reason=${msg}`);
                throw e;
            }
            this.markRuntimeUnhealthy(msg);
            if (attempt >= 2) throw e;
            console.log(`[browserSession] runtime-http reset provider=${this.provider.id} lane=${lane} manga=${mangaId} path=${apiPath} reason=${msg}`);
            if (this.isClosedContextError(e)) {
                await this.resetBrowserContext('runtime-http-closed-context');
                await this.init();
            } else {
                await this.resetRuntimeHttpPage('runtime-http-error', lane);
            }
            return this.runtimeHttpGetOwnedLocked<T>(mangaId, apiPath, params, context, attempt + 1);
        }
    }

    private shouldResetRuntimeHttp(error: unknown): boolean {
        const msg = this.errorMessage(error);
        return this.isClosedContextError(error)
            || msg.includes('Provider runtime HTTP client unavailable')
            || msg.includes('Comix main module not found')
            || msg.includes('session unavailable')
            || msg.includes('Just a moment');
    }

    private isProviderChallengeStatus(status: number): boolean {
        return status === 401 || status === 403 || status === 429 || status === 503;
    }

    private isProviderChallengeError(error: unknown): boolean {
        const msg = this.errorMessage(error);
        return /http=(401|403|429|503)\b/.test(msg)
            || msg.includes('session unavailable')
            || msg.includes('Cloudflare')
            || msg.includes('Just a moment')
            || msg.includes('challenge');
    }

    private markRuntimeHealthy(): void {
        this.runtimeHttpHealthy = true;
    }

    private markRuntimeUnhealthy(reason: string): void {
        if (!this.runtimeHttpHealthy) return;
        this.runtimeHttpHealthy = false;
        console.log(`[browserSession] runtime-unhealthy provider=${this.provider.id} reason=${reason}`);
    }

    private runInRuntimeLane<T>(lane: RuntimeHttpLane, work: () => Promise<T>): Promise<T> {
        const previous = this.runtimeLaneLocks.get(lane) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(work);
        const stored = next.finally(() => {
            if (this.runtimeLaneLocks.get(lane) === stored) this.runtimeLaneLocks.delete(lane);
        });
        stored.catch(() => undefined);
        this.runtimeLaneLocks.set(lane, stored);
        return next;
    }

    private runtimeRequestTimeoutMs(context: BrowserFetchContext = {}): number {
        switch (context.priority) {
            case 'interactive':
                return 45_000;
            case 'foreground':
                return 30_000;
            case 'observed':
                return 20_000;
            default:
                return 12_000;
        }
    }

    private async fetchMangaDetailViaRuntimeHttp(mangaId: string, context: BrowserFetchContext = {}): Promise<unknown> {
        const start = Date.now();
        const detail = await this.runtimeHttpGet<Record<string, unknown>>(mangaId, this.provider.mangaDetailPath(mangaId), undefined, context);
        const recommendations = await this.fetchMangaRecommendationsViaRuntimeHttp(mangaId, context);
        const data = this.provider.normalizeMangaDetail
            ? this.provider.normalizeMangaDetail(detail, recommendations)
            : {
                status: 'ok',
                result: {
                    ...detail,
                    recommendations,
                },
            };
        const tags = Array.isArray(detail?.tags) ? detail.tags.length : 0;
        const genres = Array.isArray(detail?.genres) ? detail.genres.length : 0;
        if (shouldLogFetchContext(context)) {
            console.log(`[browserSession] manga-detail runtime-http ${mangaId} recommendations=${recommendations.length} genres=${genres} tags=${tags} ${Date.now() - start}ms`);
        }
        return data;
    }

    private async fetchMangaRecommendationsViaRuntimeHttp(mangaId: string, context: BrowserFetchContext = {}): Promise<unknown[]> {
        const first = await this.runtimeHttpGet<Record<string, unknown>>(mangaId, this.provider.mangaRecommendationsPath(mangaId), { page: 1 }, context);
        const items = Array.isArray(first?.items) ? [...first.items] : [];
        const meta = this.asRecord(first?.meta) ?? this.asRecord(first?.pagination);
        const lastPage = Number(meta?.lastPage ?? meta?.last_page ?? 1);
        if (!Number.isFinite(lastPage) || lastPage <= 1) return items;

        const pages = Array.from({ length: Math.floor(lastPage) - 1 }, (_, i) => i + 2);
        const settled = await Promise.allSettled(
            pages.map(page => this.runtimeHttpGet<Record<string, unknown>>(mangaId, this.provider.mangaRecommendationsPath(mangaId), { page }, context)),
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

    private async fetchChapterPageViaRuntimeHttp(mangaId: string, pageNum: number, pageSize = CHAPTER_LIST_PAGE_SIZE, context: BrowserFetchContext = {}): Promise<any> {
        const cached = this.getCachedChapterPage(mangaId, pageNum, pageSize);
        if (cached) {
            if (shouldLogFetchContext(context)) {
                console.log(`[browserSession] chapter-page-cache hit ${mangaId} limit=${pageSize} page=${pageNum}`);
            }
            return cached;
        }
        const key = this.chapterPageKey(mangaId, pageNum, pageSize);
        const inflight = this.chapterPageInflight.get(key);
        if (inflight) {
            if (shouldLogFetchContext(context)) {
                console.log(`[browserSession] chapter-page-cache join ${mangaId} limit=${pageSize} page=${pageNum}`);
            }
            return inflight;
        }

        const start = Date.now();
        const promise = (async () => {
            const data = await this.runtimeHttpGet<Record<string, unknown> | unknown[]>(mangaId, this.provider.chapterListPath(mangaId), this.provider.chapterListParams(pageNum, pageSize), context);
            const fetchMs = Date.now() - start;
            const dataRecord = !Array.isArray(data) && data && typeof data === 'object'
                ? data as Record<string, unknown>
                : {};
            const itemsRaw = Array.isArray(data) ? data : dataRecord.items;
            const paginationRaw = Array.isArray(data)
                ? {
                    current_page: 1,
                    page: 1,
                    last_page: 1,
                    lastPage: 1,
                    total: data.length,
                }
                : dataRecord.meta ?? dataRecord.pagination;

            const envelope = this.assertChapterListPayload(mangaId, pageNum, {
                status: 'ok',
                result: {
                    items: itemsRaw ?? [],
                    pagination: paginationRaw,
                },
            });
            const items = Array.isArray(itemsRaw) ? itemsRaw.length : 0;
            const pagination = this.asRecord(paginationRaw);
            const total = Number(pagination?.total ?? items);
            if (shouldLogFetchContext(context)) {
                console.log(`[browserSession] runtime-http chapters ${mangaId} page=${pageNum} limit=${pageSize} items=${items} total=${Number.isFinite(total) ? total : items} ${fetchMs}ms`);
            }
            this.rememberChapterPage(mangaId, pageNum, envelope, pageSize);
            return envelope;
        })().finally(() => this.chapterPageInflight.delete(key));
        this.chapterPageInflight.set(key, promise);
        return promise;
    }

    async destroy(): Promise<void> {
        this._ready = false;
        this.stopBrowserSurfaceLog();
        await this.decoder?.destroy().catch(() => {});
        this.decoder = null;
        if (this.context) {
            await this.context.close().catch(() => {});
            this.context = null;
            this.resetRuntimeHttpState();
            this.initPromise = null;
            console.log(`[browserSession] destroyed ${this.provider.domain}`);
        }
    }

    private startBrowserSurfaceLog(): void {
        if (this.surfaceLogTimer) return;
        void this.logBrowserSurface('startup');
        this.surfaceLogTimer = setInterval(() => {
            void this.logBrowserSurface('periodic');
        }, BROWSER_SURFACE_LOG_MS);
        this.surfaceLogTimer.unref();
    }

    private stopBrowserSurfaceLog(): void {
        if (!this.surfaceLogTimer) return;
        clearInterval(this.surfaceLogTimer);
        this.surfaceLogTimer = null;
    }

    private async logBrowserSurface(reason: string): Promise<void> {
        const pageCount = this.context?.pages().filter(page => !page.isClosed()).length ?? 0;
        const proc = await this.collectBrowserProcesses().catch(() => null);
        if (!proc) {
            console.log(`[browserSession] surface reason=${reason} pages=${pageCount} processStats=unavailable`);
            return;
        }
        console.log(`[browserSession] surface reason=${reason} pages=${pageCount} renderers=${proc.renderers} totalProcesses=${proc.processes} cpu=${proc.cpu.toFixed(1)} rssMb=${Math.round(proc.rssKb / 1024)}`);
    }

    private collectBrowserProcesses(): Promise<{ processes: number; renderers: number; cpu: number; rssKb: number }> {
        return new Promise((resolve, reject) => {
            execFile('ps', ['-eo', 'pcpu,rss,args'], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
                if (error) {
                    reject(error);
                    return;
                }
                let processes = 0;
                let renderers = 0;
                let cpu = 0;
                let rssKb = 0;
                const profileNeedle = `--user-data-dir=${this.profileDir}`;
                for (const line of stdout.split('\n')) {
                    if (!line.includes(profileNeedle)) continue;
                    const match = /^\s*([\d.]+)\s+(\d+)\s+(.+)$/.exec(line);
                    if (!match) continue;
                    processes += 1;
                    cpu += Number(match[1]) || 0;
                    rssKb += Number(match[2]) || 0;
                    if (match[3]?.includes('--type=renderer')) renderers += 1;
                }
                resolve({ processes, renderers, cpu, rssKb });
            });
        });
    }
}
