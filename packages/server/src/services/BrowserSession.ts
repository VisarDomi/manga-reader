import { chromium, type BrowserContext, type Page } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import type { ServerMangaProvider } from '../providers/types.js';
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

export interface BrowserFetchResult {
    data: unknown;
    durationMs: number;
}

export interface BrowserDecodeResult {
    buffer: Buffer;
    contentType: 'image/png';
    durationMs: number;
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
    private runtimeHttpReady = false;
    private runtimeHttpInit: Promise<void> | null = null;
    private _ready = false;
    private initPromise: Promise<void> | null = null;
    private readonly profileDir: string;
    private readonly mangaDetailCache = new Map<string, MangaDetailCacheEntry>();
    private readonly chapterPageCache = new Map<string, ChapterListCacheEntry>();
    private readonly chapterPageInflight = new Map<string, Promise<unknown>>();
    private readonly chapterDetailCache = new Map<string, ChapterDetailCacheEntry>();
    private readonly chapterDetailInflight = new Map<string, Promise<unknown>>();
    private decoder: ScrambledPageDecoder | null = null;
    private surfaceLogTimer: NodeJS.Timeout | null = null;

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
            await this.claimStartupPage();
            this.decoder = new ScrambledPageDecoder(this.context, this.provider);

            console.log(`[browserSession] ready ${this.provider.domain} ${Date.now() - start}ms`);
            this._ready = true;
            this.startBrowserSurfaceLog();
        } catch (e) {
            this._ready = false;
            this.initPromise = null;
            if (this.context) {
                await this.context.close().catch(() => {});
                this.context = null;
                this.runtimeHttpPage = null;
                this.runtimeHttpReady = false;
                this.runtimeHttpInit = null;
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
        this.runtimeHttpPage = owned;
        this.runtimeHttpReady = false;
        const results = await Promise.allSettled(orphans.map(page => page.close()));
        const failed = results.filter(result => result.status === 'rejected').length;
        console.log(`[browserSession] startup-pages-adopted kept=1 closed=${orphans.length} failed=${failed} ${Date.now() - start}ms`);
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

    async fetchChapterImages(mangaId: string, chapterId: string, chapterNumber?: number, chapterUrl?: string): Promise<BrowserFetchResult> {
        await this.init();
        const start = Date.now();
        try {
            const data = await this.fetchChapterDetailCached(mangaId, chapterId, chapterNumber, chapterUrl);
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

    private async fetchChapterDetailCached(mangaId: string, chapterId: string, chapterNumber?: number, chapterUrl?: string): Promise<unknown> {
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

        const promise = this.fetchChapterDetailViaRuntimeHttp(mangaId, chapterId, chapterNumber, chapterUrl)
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

    private async fetchChapterDetailViaRuntimeHttp(mangaId: string, chapterId: string, chapterNumber?: number, chapterUrl?: string): Promise<unknown> {
        const t0 = Date.now();
        const detail = await this.runtimeHttpGet<Record<string, unknown>>(mangaId, this.provider.chapterImagesPath(chapterId));
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
            console.log(`[browserSession] chapter ${mangaId}/${chapterId} page-load reason=user source=${normalized.source}-incomplete pages=${normalized.pages.length} targetCount=${normalized.targetCount} ${Date.now() - t0}ms`);
            throw new Error(`Runtime HTTP returned incomplete chapter images for ${mangaId}/${chapterId}: pages=${normalized.pages.length} targetCount=${normalized.targetCount}`);
        }
        const scrambled = normalized.pages.filter(page => page.scramble).length;
        console.log(`[browserSession] chapter ${mangaId}/${chapterId} page-load reason=user source=${normalized.source} schema=${normalized.schemaVersion} pages=${normalized.pages.length} targetCount=${normalized.targetCount} scrambled=${scrambled} ${Date.now() - t0}ms`);
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

    private async ensureRuntimeHttpPage(mangaId: string): Promise<Page> {
        if (this.runtimeHttpPage && !this.runtimeHttpPage.isClosed() && this.runtimeHttpReady) return this.runtimeHttpPage;
        if (!this.runtimeHttpInit) {
            this.runtimeHttpInit = this.createRuntimeHttpPage(mangaId).finally(() => {
                this.runtimeHttpInit = null;
            });
        }
        await this.runtimeHttpInit;
        if (!this.runtimeHttpPage || this.runtimeHttpPage.isClosed()) {
            throw new Error(`${this.provider.name} runtime HTTP page unavailable`);
        }
        return this.runtimeHttpPage;
    }

    private async createRuntimeHttpPage(mangaId: string): Promise<void> {
        const start = Date.now();
        let page: Page | null = this.runtimeHttpPage && !this.runtimeHttpPage.isClosed()
            ? this.runtimeHttpPage
            : null;

        if (!page) {
            page = await this.context!.newPage();
        }

        try {
            this.runtimeHttpReady = false;
            await page.goto(this.provider.runtimePageUrl(mangaId), { waitUntil: 'domcontentloaded', timeout: 15_000 });
            await this.provider.resolveRuntimeHttpClient(page, mangaId, 'browserSession');
            this.runtimeHttpPage = page;
            this.runtimeHttpReady = true;
            console.log(`[browserSession] runtime-http ready ${mangaId} ${Date.now() - start}ms`);
        } catch (error) {
            if (this.runtimeHttpPage === page) {
                this.runtimeHttpPage = null;
            }
            this.runtimeHttpReady = false;
            const msg = (error as Error)?.message ?? String(error);
            await page.close().catch(closeError => {
                console.log(`[browserSession] runtime-http init-page-close failed manga=${mangaId}: ${(closeError as Error)?.message ?? closeError}`);
            });
            console.log(`[browserSession] runtime-http init-failed manga=${mangaId} ${Date.now() - start}ms ${msg}`);
            throw error;
        }
    }

    private async resetRuntimeHttpPage(reason: string): Promise<void> {
        const page = this.runtimeHttpPage;
        this.runtimeHttpPage = null;
        this.runtimeHttpReady = false;
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
        this.stopBrowserSurfaceLog();
        await this.decoder?.destroy().catch(() => {});
        this.decoder = null;
        if (this.context) {
            await this.context.close().catch(() => {});
            this.context = null;
            this.runtimeHttpPage = null;
            this.runtimeHttpInit = null;
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
