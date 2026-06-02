import type { BrowserContext, CDPSession, Page } from 'playwright';
import type { ServerMangaProvider } from '../providers/types.js';

export interface ScrambledPageDecodeRequest {
  mangaId: string;
  chapterId: string;
  chapterNumber?: number;
  chapterUrl?: string;
  pageIndex: number;
  policy?: ScrambledPageDecodePolicy;
  pages: Array<{ url: string; width: number; height: number; scramble: boolean }>;
  imageUrlCandidates?: string[];
}

export type ScrambledPageDecodePolicy = 'critical' | 'preload';

export interface ScrambledPageDecodeResult {
  buffer: Buffer;
  contentType: 'image/png';
  durationMs: number;
}

interface DecodeJob {
  id: number;
  cacheKey: string;
  request: ScrambledPageDecodeRequest;
  policy: ScrambledPageDecodePolicy;
  queuedAt: number;
  resolve: (result: ScrambledPageDecodeResult) => void;
  reject: (error: unknown) => void;
}

interface DecodedPageCacheEntry {
  buffer: Buffer;
  contentType: 'image/png';
  bytes: number;
  lastUsedAt: number;
}

class DecodePreempted extends Error {
  constructor() {
    super('preload decode preempted by critical work');
    this.name = 'DecodePreempted';
  }
}

export class ScrambledPageDecodeSourceExhausted extends Error {
  constructor(
    readonly mangaId: string,
    readonly chapterId: string,
    readonly pageIndex: number,
    readonly sourceCount: number,
    readonly lastError: unknown,
  ) {
    super(`All scrambled page sources failed for ${mangaId}/${chapterId} page=${pageIndex + 1} sources=${sourceCount}`);
    this.name = 'ScrambledPageDecodeSourceExhausted';
  }
}

export class ScrambledPageDecoder {
  private static readonly MAX_MEMORY_CACHE_BYTES = 96 * 1024 * 1024;

  private page: Page | null = null;
  private jobs: DecodeJob[] = [];
  private pendingByKey = new Map<string, DecodeJob>();
  private cache = new Map<string, DecodedPageCacheEntry>();
  private cacheBytes = 0;
  private running = false;
  private runningPolicy: ScrambledPageDecodePolicy | null = null;
  private moduleReady = false;
  private warmPromise: Promise<void> | null = null;
  private nextJobId = 1;
  private cdpSession: CDPSession | null = null;
  private preemptRunningPreload = false;

  constructor(
    private readonly context: BrowserContext,
    private readonly provider: ServerMangaProvider,
  ) {}

  decode(request: ScrambledPageDecodeRequest): Promise<ScrambledPageDecodeResult> {
    const target = request.pages[request.pageIndex];
    if (!target?.scramble) {
      return Promise.reject(new Error(`Page ${request.pageIndex + 1} is not marked scrambled`));
    }

    const cacheKey = this.cacheKey(request, target);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      cached.lastUsedAt = Date.now();
      console.log(`[decoder] request cache=hit policy=${request.policy ?? 'preload'} manga=${request.mangaId} chapter=${request.chapterId} page=${request.pageIndex + 1} bytes=${cached.bytes}`);
      return Promise.resolve({ buffer: cached.buffer, contentType: cached.contentType, durationMs: 0 });
    }

    const existing = this.pendingByKey.get(cacheKey);
    const policy = request.policy ?? 'preload';
    if (existing) {
      if (policy === 'critical' && existing.policy !== 'critical') {
        existing.policy = 'critical';
        existing.request.policy = 'critical';
        if (this.runningPolicy === 'preload') this.preemptRunningPreload = true;
        this.sortJobs();
      }
      console.log(`[decoder] request cache=pending policy=${policy} ownerPolicy=${existing.policy} manga=${request.mangaId} chapter=${request.chapterId} page=${request.pageIndex + 1} queueDepth=${this.jobs.length}`);
      return new Promise((resolve, reject) => {
        existing.resolve = this.joinResolvers(existing.resolve, resolve);
        existing.reject = this.joinRejectors(existing.reject, reject);
      });
    }

    return new Promise((resolve, reject) => {
      const job: DecodeJob = {
        id: this.nextJobId++,
        cacheKey,
        request: { ...request, policy },
        policy,
        queuedAt: Date.now(),
        resolve,
        reject,
      };
      this.jobs.push(job);
      this.pendingByKey.set(cacheKey, job);
      if (policy === 'critical' && this.runningPolicy === 'preload') this.preemptRunningPreload = true;
      this.sortJobs();
      console.log(`[decoder] request cache=miss policy=${policy} manga=${request.mangaId} chapter=${request.chapterId} page=${request.pageIndex + 1} queueDepth=${this.jobs.length}`);
      this.pump();
    });
  }

  warm(mangaId: string): void {
    if (this.page && !this.page.isClosed() && this.moduleReady) return;
    if (this.running || this.jobs.length > 0) {
      console.log(`[decoder] warm-skipped manga=${mangaId} reason=decode-queue-active queueDepth=${this.jobs.length}`);
      return;
    }
    if (this.warmPromise) return;

    const start = Date.now();
    this.warmPromise = this.warmNow(mangaId)
      .then(() => {
        console.log(`[decoder] warm-ready manga=${mangaId} ${Date.now() - start}ms`);
      })
      .catch(error => {
        this.moduleReady = false;
        console.log(`[decoder] warm-failed manga=${mangaId} ${Date.now() - start}ms error=${this.errorMessage(error)}`);
      })
      .finally(() => {
        this.warmPromise = null;
      });
  }

  hasCriticalWork(): boolean {
    return this.runningPolicy === 'critical' || this.jobs.some(job => job.policy === 'critical');
  }

  async destroy(): Promise<void> {
    const page = this.page;
    this.page = null;
    this.cdpSession = null;
    this.moduleReady = false;
    this.warmPromise = null;
    this.jobs.splice(0);
    this.pendingByKey.clear();
    this.cache.clear();
    this.cacheBytes = 0;
    if (page && !page.isClosed()) await page.close().catch(() => {});
  }

  private pump(): void {
    if (this.running) return;
    this.running = true;
    void this.runQueue();
  }

  private async runQueue(): Promise<void> {
    while (this.jobs.length > 0) {
      this.sortJobs();
      const job = this.jobs.shift()!;
      this.pendingByKey.delete(job.cacheKey);
      const waitMs = Date.now() - job.queuedAt;
      this.runningPolicy = job.policy;
      console.log(`[decoder] start policy=${job.policy} manga=${job.request.mangaId} chapter=${job.request.chapterId} page=${job.request.pageIndex + 1} waitMs=${waitMs} queueDepth=${this.jobs.length}`);
      try {
        const cached = this.cache.get(job.cacheKey);
        if (cached) {
          cached.lastUsedAt = Date.now();
          job.resolve({ buffer: cached.buffer, contentType: cached.contentType, durationMs: 0 });
          continue;
        }
        const result = await this.decodeNow(job.request, waitMs);
        this.putCache(job.cacheKey, result);
        job.resolve(result);
      } catch (error) {
        if (error instanceof DecodePreempted) {
          this.preemptRunningPreload = false;
          job.queuedAt = Date.now();
          this.jobs.push(job);
          this.pendingByKey.set(job.cacheKey, job);
          this.sortJobs();
          console.log(`[decoder] preempted policy=${job.policy} manga=${job.request.mangaId} chapter=${job.request.chapterId} page=${job.request.pageIndex + 1} queuedCritical=${this.jobs.some(item => item.policy === 'critical')} queueDepth=${this.jobs.length}`);
        } else {
          job.reject(error);
        }
      } finally {
        this.runningPolicy = null;
      }
    }
    this.running = false;
    if (this.jobs.length > 0) this.pump();
  }

  private sortJobs(): void {
    this.jobs.sort((a, b) => {
      if (a.policy !== b.policy) return a.policy === 'critical' ? -1 : 1;
      return a.id - b.id;
    });
  }

  private joinResolvers(
    left: (result: ScrambledPageDecodeResult) => void,
    right: (result: ScrambledPageDecodeResult) => void,
  ): (result: ScrambledPageDecodeResult) => void {
    return result => {
      left(result);
      right(result);
    };
  }

  private joinRejectors(
    left: (error: unknown) => void,
    right: (error: unknown) => void,
  ): (error: unknown) => void {
    return error => {
      left(error);
      right(error);
    };
  }

  private cacheKey(request: ScrambledPageDecodeRequest, target: { url: string; width: number; height: number }): string {
    return `${request.mangaId}:${request.chapterId}:${request.pageIndex}:${target.width}x${target.height}:${target.url}`;
  }

  private putCache(cacheKey: string, result: ScrambledPageDecodeResult): void {
    const bytes = result.buffer.length;
    const existing = this.cache.get(cacheKey);
    if (existing) this.cacheBytes -= existing.bytes;
    this.cache.set(cacheKey, {
      buffer: result.buffer,
      contentType: result.contentType,
      bytes,
      lastUsedAt: Date.now(),
    });
    this.cacheBytes += bytes;
    this.evictCache();
  }

  private evictCache(): void {
    while (this.cacheBytes > ScrambledPageDecoder.MAX_MEMORY_CACHE_BYTES && this.cache.size > 0) {
      let oldestKey: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.cache) {
        if (entry.lastUsedAt < oldestAt) {
          oldestAt = entry.lastUsedAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) return;
      const oldest = this.cache.get(oldestKey);
      if (oldest) this.cacheBytes -= oldest.bytes;
      this.cache.delete(oldestKey);
    }
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    this.page = await this.context.newPage();
    this.cdpSession = null;
    return this.page;
  }

  private async ensureCdpSession(page: Page): Promise<CDPSession> {
    if (this.cdpSession && !page.isClosed()) return this.cdpSession;
    this.cdpSession = await page.context().newCDPSession(page);
    return this.cdpSession;
  }

  private async decodeNow(request: ScrambledPageDecodeRequest, waitMs: number): Promise<ScrambledPageDecodeResult> {
    const start = Date.now();
    const target = request.pages[request.pageIndex];
    if (!target?.scramble) {
      throw new Error(`Page ${request.pageIndex + 1} is not marked scrambled`);
    }

    const activeWarm = this.warmPromise;
    if (activeWarm) await activeWarm.catch(error => {
      console.log(`[decoder] active-warm-failed-before-decode manga=${request.mangaId} chapter=${request.chapterId} page=${request.pageIndex + 1} error=${this.errorMessage(error)}`);
    });
    const page = await this.ensurePage();
    const pageMs = Date.now() - start;
    const warmupActive = Boolean(activeWarm);
    const currentUrl = page.url();
    const navigateStart = Date.now();
    let navigateMs = 0;
    if (!currentUrl.startsWith(this.provider.baseUrl)) {
      await page.goto(this.provider.runtimePageUrl(request.mangaId), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(error => {
        console.log(`[decoder] networkidle-timeout phase=decode manga=${request.mangaId} error=${this.errorMessage(error)}`);
      });
      this.moduleReady = false;
      navigateMs = Date.now() - navigateStart;
    }
    const moduleStart = Date.now();
    await this.ensureSecureDecoderModule(page);
    const moduleMs = Date.now() - moduleStart;

    const decodeStart = Date.now();
    const sourceUrls = this.sourceCandidates(request, target.url);
    let canvasId = '';
    let canvasMeta: { width: number; height: number; cssWidth: number; cssHeight: number };
    let sourceUrl = target.url;
    let lastError: unknown = null;
    for (let index = 0; index < sourceUrls.length; index += 1) {
      if ((request.policy ?? 'preload') !== 'critical' && (this.preemptRunningPreload || this.jobs.some(job => job.policy === 'critical'))) {
        throw new DecodePreempted();
      }
      sourceUrl = sourceUrls[index]!;
      canvasId = `manga-decoder-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const sourceStart = Date.now();
      try {
        canvasMeta = await page.evaluate(async ({ imageUrl, width, height, canvasId }) => {
          const decode = await (globalThis as any).__mangaSecureDecode();
          const canvas = document.createElement('canvas');
          canvas.id = canvasId;
          canvas.width = width;
          canvas.height = height;
          canvas.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px;z-index:2147483647;background:#000`;
          document.body.prepend(canvas);
          try {
            await decode(imageUrl, canvas);
            const rect = canvas.getBoundingClientRect();
            return { width: canvas.width, height: canvas.height, cssWidth: Math.round(rect.width), cssHeight: Math.round(rect.height) };
          } catch (error) {
            canvas.remove();
            throw error;
          }
        }, { imageUrl: sourceUrl, width: target.width, height: target.height, canvasId });
        if (index > 0) {
          console.log(`[decoder] source-recovered policy=${request.policy ?? 'preload'} manga=${request.mangaId} chapter=${request.chapterId} page=${request.pageIndex + 1} host=${this.hostFromUrl(sourceUrl)} index=${index + 1}/${sourceUrls.length} ms=${Date.now() - sourceStart}`);
        }
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        console.log(`[decoder] source-failed policy=${request.policy ?? 'preload'} manga=${request.mangaId} chapter=${request.chapterId} page=${request.pageIndex + 1} host=${this.hostFromUrl(sourceUrl)} index=${index + 1}/${sourceUrls.length} ms=${Date.now() - sourceStart} error=${this.errorMessage(error)}`);
      }
    }
    if (lastError) {
      throw new ScrambledPageDecodeSourceExhausted(
        request.mangaId,
        request.chapterId,
        request.pageIndex,
        sourceUrls.length,
        lastError,
      );
    }
    const decodeMs = Date.now() - decodeStart;

    const canvas = await page.$(`#${canvasId}`);
    if (!canvas) throw new Error('Decoded canvas element unavailable');
    const screenshotStart = Date.now();
    const cdp = await this.ensureCdpSession(page);
    const screenshot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      optimizeForSpeed: true,
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: 0,
        width: target.width,
        height: target.height,
        scale: 1,
      },
    });
    const buffer = Buffer.from(screenshot.data, 'base64');
    const screenshotMs = Date.now() - screenshotStart;
    await page.evaluate(id => document.getElementById(id)?.remove(), canvasId).catch(error => {
      console.log(`[decoder] canvas-cleanup-failed manga=${request.mangaId} chapter=${request.chapterId} page=${request.pageIndex + 1} error=${this.errorMessage(error)}`);
    });
    console.log(`[decoder] page-decoded policy=${request.policy ?? 'preload'} manga=${request.mangaId} chapter=${request.chapterId} page=${request.pageIndex + 1} bytes=${buffer.length} expected=${target.width}x${target.height} canvas=${canvasMeta!.width}x${canvasMeta!.height} css=${canvasMeta!.cssWidth}x${canvasMeta!.cssHeight} source=secure-module sourceHost=${this.hostFromUrl(sourceUrl)} sourceCandidates=${sourceUrls.length} waitMs=${waitMs} pageMs=${pageMs} warmupActive=${warmupActive} navigateMs=${navigateMs} moduleMs=${moduleMs} decodeMs=${decodeMs} screenshotMs=${screenshotMs} totalMs=${Date.now() - start}`);
    return { buffer, contentType: 'image/png', durationMs: Date.now() - start };
  }

  private async warmNow(mangaId: string): Promise<void> {
    const page = await this.ensurePage();
    const currentUrl = page.url();
    if (!currentUrl.startsWith(this.provider.baseUrl)) {
      await page.goto(this.provider.runtimePageUrl(mangaId), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(error => {
        console.log(`[decoder] networkidle-timeout phase=warm manga=${mangaId} error=${this.errorMessage(error)}`);
      });
      this.moduleReady = false;
    }
    await this.ensureSecureDecoderModule(page);
  }

  private sourceCandidates(request: ScrambledPageDecodeRequest, targetUrl: string): string[] {
    const candidates = new Set<string>();
    candidates.add(targetUrl);
    for (const url of request.imageUrlCandidates ?? []) {
      if (url) candidates.add(url);
    }
    return [...candidates];
  }

  private hostFromUrl(value: string): string {
    try {
      return new URL(value).hostname.toLowerCase();
    } catch {
      return 'invalid';
    }
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) return `${error.name}:${error.message}`.replace(/\s+/g, ' ').slice(0, 240);
    return String(error).replace(/\s+/g, ' ').slice(0, 240);
  }

  private async ensureSecureDecoderModule(page: Page): Promise<void> {
    if (this.moduleReady && !page.isClosed()) return;
    await page.evaluate(async () => {
      if (typeof (globalThis as any).__mangaSecureDecode === 'function') return;
      (globalThis as any).__mangaSecureDecode = async () => {
        if ((globalThis as any).__mangaSecureDecodeFn) return (globalThis as any).__mangaSecureDecodeFn;
        const scripts = [...document.scripts].map(script => script.src).filter(Boolean);
        const buildScript = scripts.find(src => src.includes('/assets/build/') && src.includes('/dist/'));
        const baseUrl = buildScript
          ? buildScript.replace(/\/[^/]+$/, '/')
          : '/assets/build/35595e3de3c99889c1aa70/dist/';
        const mod = await import(new URL('secure-tfu3ef-CDCmLh9b.js', baseUrl).toString());
        const decode = mod?.t;
        if (typeof decode !== 'function') throw new Error('Comix secure decoder unavailable');
        (globalThis as any).__mangaSecureDecodeFn = decode;
        return decode;
      };
      await (globalThis as any).__mangaSecureDecode();
    });
    this.moduleReady = true;
  }
}
