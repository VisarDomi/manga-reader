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
    '--ignore-gpu-blocklist',
    '--window-size=1920,1080',
];

const IGNORE_DEFAULT_ARGS = ['--enable-automation', '--enable-unsafe-swiftshader'];

/**
 * Injected before any page JS. Intercepts fetch() to capture the signing
 * parameters that comix.to's apiClient adds to requests.
 * Then exposes a signedFetch function that reuses the captured signing.
 */
const CAPTURE_SCRIPT = `(function() {
    var origFetch = globalThis.fetch;
    var csrfToken = null;
    var signFn = null;

    globalThis.fetch = function(input, init) {
        var url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
        if (url.indexOf('/api/v2/') !== -1) {
            var headers = init && init.headers;
            if (headers) {
                var csrf = null;
                if (headers instanceof Headers) {
                    csrf = headers.get('X-CSRF-TOKEN');
                } else if (typeof headers === 'object') {
                    csrf = headers['X-CSRF-TOKEN'] || null;
                }
                if (csrf) csrfToken = csrf;
            }
            var parsed = new URL(url, location.origin);
            var sig = parsed.searchParams.get('_');
            var time = parsed.searchParams.get('time');
            if (sig) {
                globalThis.__comixLastSig = { sig: sig, time: time, url: url, ts: Date.now() };
            }
        }
        return origFetch.apply(this, arguments);
    };

    globalThis.__comixGetCsrf = function() { return csrfToken; };
})();`;

const API_BASE = '/api/v2';

export interface BrowserFetchResult {
    data: unknown;
    durationMs: number;
}

/**
 * Owns a persistent Playwright page on a target domain.
 *
 * Provides signedFetch() that makes API calls through the page's JS context,
 * inheriting CSRF tokens and request signing that the page's apiClient handles.
 *
 * Ownership: Server creates → App borrows → ProxyRoute borrows for fallback.
 */
export class BrowserSession {
    private context: BrowserContext | null = null;
    private page: Page | null = null;
    private _ready = false;
    private initPromise: Promise<void> | null = null;
    private readonly profileDir: string;

    constructor(
        private readonly domain: string,
        private readonly startUrl: string,
    ) {
        this.profileDir = path.join(PROFILE_BASE, `${domain}-session`);
    }

    get ready(): boolean {
        return this._ready;
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

        this.page = this.context.pages()[0] || await this.context.newPage();
        await this.page.addInitScript(CAPTURE_SCRIPT);
        await this.page.goto(this.startUrl, { waitUntil: 'networkidle', timeout: 30_000 });

        const hasClient = await this.page.evaluate(() => !!(globalThis as any).__comixApiClient);
        const ms = Date.now() - start;

        if (hasClient) {
            console.log(`[browserSession] ready ${this.domain} apiClient=captured ${ms}ms`);
        } else {
            console.log(`[browserSession] ready ${this.domain} apiClient=missing ${ms}ms`);
        }

        this._ready = true;
    }

    /**
     * Make a signed API request by navigating to the manga page and
     * intercepting the signed response that the page's JS produces.
     *
     * The page's apiClient owns CSRF + signing — we trigger it via navigation
     * and capture the result through Playwright's response interception.
     *
     * @param fullUrl Full API URL (e.g. https://comix.to/api/v2/manga/80km/chapters?limit=100&page=1)
     * @returns The full API response (with { status, result } envelope)
     */
    async signedFetch(fullUrl: string): Promise<BrowserFetchResult> {
        if (!this._ready || !this.page) {
            throw new Error('BrowserSession not ready');
        }

        const parsed = new URL(fullUrl);
        const pathStr = parsed.pathname + parsed.search;

        // Extract mangaId from URL: /api/v2/manga/{mangaId}/chapters?...
        const match = parsed.pathname.match(/\/manga\/([^/]+)\/chapters/);
        if (!match) {
            throw new Error(`Cannot extract mangaId from ${parsed.pathname}`);
        }
        const mangaId = match[1];
        const start = Date.now();

        try {
            const data = await this.fetchViaNavigation(mangaId, pathStr);
            const durationMs = Date.now() - start;
            console.log(`[browserSession] fetch ${pathStr} ${durationMs}ms`);
            return { data, durationMs };
        } catch (e) {
            const durationMs = Date.now() - start;
            const msg = (e as Error)?.message ?? String(e);
            console.log(`[browserSession] fetch-error ${pathStr} ${durationMs}ms ${msg}`);
            throw e;
        }
    }

    /**
     * Navigate to a manga page and collect ALL chapters across all pages.
     *
     * The page's JS signs requests — we capture page 1 via navigation,
     * then use the browser's JS context to fetch remaining pages through
     * the same signed apiClient. We scroll/click to trigger pagination
     * in the page, or evaluate the mangaApi.chapters() function directly.
     *
     * Returns a synthetic response that merges all pages into one.
     */
    private async fetchViaNavigation(mangaId: string, _targetPath: string): Promise<unknown> {
        const page = this.page!;

        // Step 1: navigate to manga page, intercept page 1 response + signed request
        const page1Data = await new Promise<{ json: any; signedUrl: string }>((resolve, reject) => {
            let settled = false;
            const timeout = setTimeout(() => {
                if (settled) return;
                settled = true;
                page.off('response', handler);
                reject(new Error('Timed out waiting for chapters response'));
            }, 15_000);

            const handler = async (response: import('playwright').Response) => {
                if (settled) return;
                const url = response.url();
                if (!url.includes(`/manga/${mangaId}/chapters`)) return;

                settled = true;
                clearTimeout(timeout);
                page.off('response', handler);

                try {
                    resolve({ json: await response.json(), signedUrl: url });
                } catch (e) {
                    reject(e);
                }
            };

            page.on('response', handler);
            page.goto(`https://${this.domain}/title/${mangaId}`, {
                waitUntil: 'commit',
                timeout: 15_000,
            }).catch(e => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    page.off('response', handler);
                    reject(e);
                }
            });
        });

        const { json: firstPage, signedUrl } = page1Data;
        const pagination = firstPage?.result?.pagination;
        const lastPage = pagination?.last_page ?? 1;

        const page1Items = firstPage.result?.items ?? [];

        if (lastPage <= 1) {
            console.log(`[browserSession] chapters ${mangaId} page=1/1 items=${page1Items.length} total=${pagination?.total ?? page1Items.length}`);
            return firstPage;
        }

        console.log(`[browserSession] chapters ${mangaId} page=1/${lastPage} items=${page1Items.length} total=${pagination?.total ?? '?'} — fetching remaining`);

        // Step 2: fetch remaining pages using the browser's signed context.
        const allItems = [...page1Items];
        let failed = 0;

        for (let p = 2; p <= lastPage; p++) {
            try {
                const pageData = await this.fetchSignedPage(mangaId, signedUrl, p);
                const items = pageData?.result?.items ?? pageData?.items ?? [];
                if (items.length > 0) {
                    allItems.push(...items);
                    console.log(`[browserSession] chapters ${mangaId} page=${p}/${lastPage} items=${items.length}`);
                } else {
                    failed++;
                    console.log(`[browserSession] chapters ${mangaId} page=${p}/${lastPage} items=0 (soft-403 or empty)`);
                }
            } catch (e) {
                failed++;
                console.log(`[browserSession] chapters ${mangaId} page=${p}/${lastPage} error: ${(e as Error).message}`);
            }
        }

        console.log(`[browserSession] chapters ${mangaId} done pages=${lastPage} fetched=${allItems.length} failed=${failed}`);

        // Return a merged response that looks like a single page with all items
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

    /**
     * Fetch a specific page of chapters by evaluating fetch() in the browser
     * with the signing context. We take the signed URL from page 1 and
     * ask the page's apiClient to fetch a different page.
     */
    private async fetchSignedPage(mangaId: string, _signedUrl: string, pageNum: number): Promise<any> {
        const page = this.page!;

        // Use the page's JS to call the chapters API for a specific page.
        // The apiClient handles signing automatically.
        return page.evaluate(
            async ({ mangaId, pageNum }) => {
                // Try to find the apiClient via the captured reference
                const client = (globalThis as any).__comixApiClient;
                if (client) {
                    return await client.get(`/manga/${mangaId}/chapters`, {
                        query: { limit: '20', page: String(pageNum), 'order[number]': 'desc' },
                    });
                }

                // Fallback: find the CSRF token from cookies and make a direct fetch
                const csrfMatch = document.cookie.match(/XSRF-TOKEN=([^;]+)/);
                const csrf = csrfMatch ? decodeURIComponent(csrfMatch[1]) : null;
                const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                if (csrf) headers['X-CSRF-TOKEN'] = csrf;

                const url = `/api/v2/manga/${mangaId}/chapters?limit=20&page=${pageNum}&order%5Bnumber%5D=desc`;
                const res = await fetch(url, { headers });
                return await res.json();
            },
            { mangaId, pageNum },
        );
    }

    async destroy(): Promise<void> {
        this._ready = false;
        if (this.context) {
            await this.context.close().catch(() => {});
            this.context = null;
            this.page = null;
            this.initPromise = null;
            console.log(`[browserSession] destroyed ${this.domain}`);
        }
    }
}
