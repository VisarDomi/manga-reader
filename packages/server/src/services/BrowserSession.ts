import { chromium, type BrowserContext, type Page } from 'playwright';
import path from 'node:path';
import os from 'node:os';

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

const SIGNED_PATTERN = /\/manga\/([^/]+)\/chapters/;
const POOL_SIZE = 4;

export interface BrowserFetchResult {
    data: unknown;
    durationMs: number;
}

const enum Priority { USER = 0, PREWARM = 1 }

interface WorkItem {
    mangaId: string;
    priority: Priority;
    resolve: (sig: string) => void;
    reject: (err: Error) => void;
}

class NavigationScheduler {
    private readonly queue: WorkItem[] = [];
    private readonly sigCache = new Map<string, string>();
    private readonly inflight = new Set<string>();
    private readonly pool: Page[] = [];
    private activeWorkers = 0;
    private context: BrowserContext | null = null;

    get cacheSize(): number { return this.sigCache.size; }

    setContext(ctx: BrowserContext): void {
        this.context = ctx;
    }

    getCachedSig(mangaId: string): string | undefined {
        return this.sigCache.get(mangaId);
    }

    acquire(mangaId: string, priority: Priority): Promise<string> {
        const cached = this.sigCache.get(mangaId);
        if (cached) return Promise.resolve(cached);

        const existing = this.queue.find(w => w.mangaId === mangaId);
        if (existing) {
            if (priority < existing.priority) existing.priority = priority;
            return new Promise((resolve, reject) => {
                const orig = { resolve: existing.resolve, reject: existing.reject };
                existing.resolve = (sig) => { orig.resolve(sig); resolve(sig); };
                existing.reject = (err) => { orig.reject(err); reject(err); };
            });
        }

        if (this.inflight.has(mangaId)) {
            return new Promise((resolve, reject) => {
                this.queue.push({ mangaId, priority, resolve, reject });
            });
        }

        return new Promise((resolve, reject) => {
            this.queue.push({ mangaId, priority, resolve, reject });
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
                resolve: () => {},
                reject: () => {},
            });
        }

        if (queued > 0) this.drain();
        return { queued, skipped };
    }

    private drain(): void {
        while (this.activeWorkers < POOL_SIZE && this.queue.length > 0) {
            this.queue.sort((a, b) => a.priority - b.priority);
            const item = this.queue.shift()!;

            const cached = this.sigCache.get(item.mangaId);
            if (cached) {
                item.resolve(cached);
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
            const page = await this.acquirePage();
            const t0 = Date.now();

            try {
                const sig = await this.captureSignature(page, mangaId);
                this.sigCache.set(mangaId, sig);
                console.log(`[navScheduler] ${label} ${mangaId} sig=${sig.slice(0, 16)}… ${Date.now() - t0}ms cache=${this.sigCache.size}`);
                item.resolve(sig);

                for (let i = this.queue.length - 1; i >= 0; i--) {
                    if (this.queue[i].mangaId === mangaId) {
                        this.queue[i].resolve(sig);
                        this.queue.splice(i, 1);
                    }
                }
            } finally {
                this.releasePage(page);
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

    private async acquirePage(): Promise<Page> {
        if (this.pool.length > 0) return this.pool.pop()!;
        return this.context!.newPage();
    }

    private releasePage(page: Page): void {
        if (this.pool.length < POOL_SIZE) {
            this.pool.push(page);
        } else {
            page.close().catch(() => {});
        }
    }

    private captureSignature(page: Page, mangaId: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            let settled = false;

            const timeout = setTimeout(() => {
                if (settled) return;
                settled = true;
                page.off('request', handler);
                reject(new Error('Timed out waiting for signed chapters request'));
            }, 15_000);

            const handler = (req: import('playwright').Request) => {
                if (settled) return;
                const url = req.url();
                if (!url.includes(`/manga/${mangaId}/chapters`) || !url.includes('_=')) return;

                settled = true;
                clearTimeout(timeout);
                page.off('request', handler);

                const sig = new URL(url).searchParams.get('_');
                if (sig) {
                    resolve(sig);
                } else {
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

    async destroy(): Promise<void> {
        for (const page of this.pool) {
            await page.close().catch(() => {});
        }
        this.pool.length = 0;
        console.log(`[navScheduler] destroyed pool=${POOL_SIZE} cache=${this.sigCache.size} queue=${this.queue.length}`);
    }
}

export class BrowserSession {
    private context: BrowserContext | null = null;
    private fetchPage: Page | null = null;
    private _ready = false;
    private initPromise: Promise<void> | null = null;
    private readonly profileDir: string;
    private readonly scheduler = new NavigationScheduler();

    constructor(
        private readonly domain: string,
        private readonly startUrl: string,
    ) {
        this.profileDir = path.join(PROFILE_BASE, `${domain}-session`);
    }

    get ready(): boolean {
        return this._ready;
    }

    needsSigning(url: string): boolean {
        return SIGNED_PATTERN.test(url);
    }

    async init(): Promise<void> {
        if (this.initPromise) return this.initPromise;
        this.initPromise = this.doInit();
        return this.initPromise;
    }

    private async doInit(): Promise<void> {
        const start = Date.now();
        console.log(`[browserSession] init ${this.domain}`);

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
        await this.fetchPage.goto(`${this.startUrl}/api/v2`, { waitUntil: 'domcontentloaded', timeout: 15_000 });

        console.log(`[browserSession] ready ${this.domain} ${Date.now() - start}ms`);
        this._ready = true;
    }

    async signedFetch(fullUrl: string): Promise<BrowserFetchResult> {
        if (!this._ready || !this.context) {
            throw new Error('BrowserSession not ready');
        }

        const match = fullUrl.match(SIGNED_PATTERN);
        if (!match) {
            throw new Error(`Cannot extract mangaId from ${fullUrl}`);
        }
        const mangaId = match[1];
        const start = Date.now();

        try {
            const data = await this.fetchAllChapters(mangaId);
            const durationMs = Date.now() - start;
            return { data, durationMs };
        } catch (e) {
            const durationMs = Date.now() - start;
            const msg = (e as Error)?.message ?? String(e);
            console.log(`[browserSession] fetch-error ${mangaId} ${durationMs}ms ${msg}`);
            throw e;
        }
    }

    prewarmSigs(mangaIds: string[]): void {
        if (!this._ready) return;

        const { queued, skipped } = this.scheduler.submitPrewarm(mangaIds);
        if (queued > 0) {
            console.log(`[browserSession] prewarm queued=${queued} skipped=${skipped} cache=${this.scheduler.cacheSize}`);
        }
    }

    private async fetchAllChapters(mangaId: string): Promise<unknown> {
        const t0 = Date.now();
        const cachedBefore = !!this.scheduler.getCachedSig(mangaId);
        const sig = await this.scheduler.acquire(mangaId, Priority.USER);
        const sigMs = Date.now() - t0;
        const sigSource = cachedBefore ? 'cache' : (sigMs < 5 ? 'cache' : 'nav');

        const t1 = Date.now();
        const page1 = await this.fetchChapterPage(mangaId, sig, 1);
        const p1Ms = Date.now() - t1;
        const pagination = page1?.result?.pagination;
        const lastPage = pagination?.last_page ?? 1;
        const page1Items = page1?.result?.items ?? [];

        if (lastPage <= 1) {
            console.log(`[browserSession] chapters ${mangaId} sig=${sigSource}:${sigMs}ms p1=${p1Ms}ms items=${page1Items.length} total=${pagination?.total ?? page1Items.length}`);
            return page1;
        }

        console.log(`[browserSession] chapters ${mangaId} sig=${sigSource}:${sigMs}ms p1=${p1Ms}ms page=1/${lastPage} items=${page1Items.length} total=${pagination?.total ?? '?'} — fetching remaining`);

        const t2 = Date.now();
        const pageNums = Array.from({ length: lastPage - 1 }, (_, i) => i + 2);
        const results = await Promise.allSettled(
            pageNums.map(p => this.fetchChapterPage(mangaId, sig, p)),
        );

        const allItems = [...page1Items];
        let failed = 0;
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
                failed++;
                console.log(`[browserSession] chapters ${mangaId} page=${p}/${lastPage} error: ${r.reason?.message}`);
            }
        }
        const pNMs = Date.now() - t2;

        console.log(`[browserSession] chapters ${mangaId} done sig=${sigSource}:${sigMs}ms p1=${p1Ms}ms p2-${lastPage}=${pNMs}ms fetched=${allItems.length} failed=${failed}`);

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

    private fetchChapterPage(mangaId: string, sig: string, pageNum: number): Promise<any> {
        return this.fetchPage!.evaluate(
            async ({ mangaId, sig, pageNum }) => {
                const url = `/api/v2/manga/${mangaId}/chapters?limit=100&page=${pageNum}&order%5Bnumber%5D=desc&time=1&_=${sig}`;
                const res = await fetch(url);
                return res.json();
            },
            { mangaId, sig, pageNum },
        );
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
