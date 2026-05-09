import type { BrowserSession } from '../services/BrowserSession.js';
import { learnStoreHostFromUrl, listStoreHosts } from '../utils/storeHosts.js';
import { proxyFetchJson } from '../utils/proxyFetch.js';
import { CacheDatabase, type ImageStoreObservation } from './sqlite.js';

const COMIX_API_BASE = 'https://comix.to/api/v1';
const NEWEST_LIMIT = 100;
const CHAPTER_PAGE_SIZE = 100;

type CacheJobKind = 'seed-newest' | 'cache-manga-detail' | 'cache-chapters' | 'cache-chapter-images';
type CacheJobPriority = 'foreground' | 'background';

interface CacheJob {
  kind: CacheJobKind;
  priority: CacheJobPriority;
  mangaId?: string;
  chapterId?: string;
  chapterNumber?: number;
  chapterUrl?: string;
  force?: boolean;
  reason: string;
}

function resultItems(data: unknown): unknown[] {
  if (!data || typeof data !== 'object') return [];
  const result = (data as Record<string, unknown>).result;
  if (!result || typeof result !== 'object') return [];
  const items = (result as Record<string, unknown>).items;
  return Array.isArray(items) ? items : [];
}

function resultPagination(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object') return {};
  const result = (data as Record<string, unknown>).result;
  if (!result || typeof result !== 'object') return {};
  const r = result as Record<string, unknown>;
  const pagination = r.pagination ?? r.meta;
  return pagination && typeof pagination === 'object' ? pagination as Record<string, unknown> : {};
}

function isMangaDetailPayload(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const root = data as Record<string, unknown>;
  const result = root.result;
  if (root.status !== 'ok' || !result || typeof result !== 'object') return false;
  const r = result as Record<string, unknown>;
  return typeof r.title === 'string' && r.title.length > 0;
}

function mangaIdFromItem(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const r = item as Record<string, unknown>;
  const value = r.hid ?? r.hash_id ?? r.id ?? r.slug;
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function chapterIdFromItem(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const r = item as Record<string, unknown>;
  const value = r.hid ?? r.hash_id ?? r.id ?? r.chapter_id;
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function chapterNumberFromItem(item: unknown): number | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const r = item as Record<string, unknown>;
  const value = r.number ?? r.chapter_number ?? r.chap;
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function chapterUrlFromItem(item: unknown, mangaId: string, chapterId: string, chapterNumber?: number): string {
  if (item && typeof item === 'object') {
    const r = item as Record<string, unknown>;
    const raw = r.url ?? r.path ?? r.slug;
    if (typeof raw === 'string' && raw.startsWith('http')) return raw;
    if (typeof raw === 'string' && raw.startsWith('/')) return `https://comix.to${raw}`;
  }
  const chapterPart = chapterNumber === undefined ? chapterId : `${chapterId}-chapter-${chapterNumber}`;
  return `https://comix.to/title/${mangaId}/${chapterPart}`;
}

function resultPages(data: unknown): unknown[] {
  if (!data || typeof data !== 'object') return [];
  const result = (data as Record<string, unknown>).result;
  if (!result || typeof result !== 'object') return [];
  const pages = (result as Record<string, unknown>).pages;
  return Array.isArray(pages) ? pages : [];
}

function chapterImageReadiness(data: unknown): { ready: boolean; pages: number; targetCount: number | null; source: string } {
  const pages = resultPages(data);
  const result = data && typeof data === 'object'
    ? (data as Record<string, unknown>).result
    : undefined;
  const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  const targetCount = typeof record.targetCount === 'number' && Number.isFinite(record.targetCount)
    ? record.targetCount
    : null;
  const source = typeof record.source === 'string' ? record.source : 'unknown';
  const populated = pages.filter(page => pageImageUrl(page)).length;
  const ready = source === 'site-client'
    && targetCount !== null
    && targetCount > 0
    && pages.length === targetCount
    && populated === targetCount;
  return { ready, pages: pages.length, targetCount, source };
}

function pageImageUrl(page: unknown): string | null {
  if (typeof page === 'string' && page.length > 0) return page;
  if (!page || typeof page !== 'object') return null;
  const r = page as Record<string, unknown>;
  const value = r.url ?? r.src ?? r.image ?? r.image_url;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function imageStoreCandidates(imageUrl: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return [imageUrl];
  }

  learnStoreHostFromUrl(imageUrl);
  const candidates = new Set<string>([imageUrl]);
  const originalHost = parsed.hostname.toLowerCase();
  for (const host of listStoreHosts()) {
    if (host === originalHost) continue;
    const next = new URL(imageUrl);
    next.hostname = host;
    candidates.add(next.toString());
  }
  return [...candidates];
}

export class CacheService {
  private readonly db = new CacheDatabase();
  private readonly foreground: CacheJob[] = [];
  private readonly background: CacheJob[] = [];
  private readonly imageBacklog: CacheJob[] = [];
  private active = false;
  private started = false;
  private currentJob: CacheJob | null = null;

  constructor(private readonly browserSession: BrowserSession) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.enqueue({ kind: 'seed-newest', priority: 'background', reason: 'startup' });
    this.recoverImageBacklogFromChapterCache('startup-recovery');
    console.log('[cache] start queued seed-newest reason=startup');
  }

  stop(): void {
    this.db.close();
  }

  status(): Record<string, unknown> {
    return {
      started: this.started,
      active: this.active,
      currentJob: this.currentJob,
      foreground: this.foreground.length,
      background: this.background.length,
      imageBacklog: this.imageBacklog.length,
      counts: this.db.counts(),
    };
  }

  getManga(mangaId: string): unknown | null {
    const data = this.db.getManga(mangaId)?.data ?? null;
    return isMangaDetailPayload(data) ? data : null;
  }

  getChapterList(mangaId: string): unknown | null {
    return this.db.getChapterList(mangaId)?.data ?? null;
  }

  getChapterImages(mangaId: string, chapterId: string): unknown | null {
    const cached = this.db.getChapterImages(mangaId, chapterId);
    if (!cached) return null;
    const readiness = chapterImageReadiness(cached.data);
    if (cached.status !== 'ready' || !readiness.ready) {
      console.log(`[cache] chapter-images not-ready manga=${mangaId} chapter=${chapterId} status=${cached.status} pages=${readiness.pages} targetCount=${readiness.targetCount ?? 'unknown'} source=${readiness.source}`);
      return null;
    }
    return cached.data;
  }

  refreshManga(mangaId: string, reason = 'frontend-refresh'): void {
    this.db.invalidateChapterList(mangaId);
    this.enqueue({ kind: 'cache-manga-detail', priority: 'foreground', mangaId, force: true, reason });
    this.enqueue({ kind: 'cache-chapters', priority: 'foreground', mangaId, force: true, reason });
  }

  warmManga(mangaId: string, reason = 'cache-miss'): void {
    this.enqueue({ kind: 'cache-manga-detail', priority: 'foreground', mangaId, reason });
    this.enqueue({ kind: 'cache-chapters', priority: 'foreground', mangaId, reason });
  }

  observeImageStore(observation: Omit<ImageStoreObservation, 'source'>): void {
    this.db.observeImageStore({ ...observation, source: 'frontend' });
    console.log(`[cache] image-store-observed ok=${observation.ok} status=${observation.status} image=${observation.imageUrl} store=${observation.storeUrl}`);
  }

  refreshChapterImages(mangaId: string, chapterId: string, chapterNumber?: number, chapterUrl?: string, reason = 'frontend-refresh'): void {
    this.enqueue({ kind: 'cache-chapter-images', priority: 'foreground', mangaId, chapterId, chapterNumber, chapterUrl, force: true, reason });
  }

  warmChapterImages(mangaId: string, chapterId: string, chapterNumber?: number, chapterUrl?: string, reason = 'cache-miss'): void {
    this.enqueue({ kind: 'cache-chapter-images', priority: 'foreground', mangaId, chapterId, chapterNumber, chapterUrl, reason });
  }

  private enqueue(job: CacheJob): void {
    const queue = job.priority === 'foreground'
      ? this.foreground
      : job.kind === 'cache-chapter-images'
        ? this.imageBacklog
        : this.background;
    if ((job.kind === 'cache-manga-detail' || job.kind === 'cache-chapters') && job.mangaId) {
      if (this.currentJob?.kind === job.kind && this.currentJob.mangaId === job.mangaId) return;
      if (this.promoteQueuedMangaJob(job)) {
        this.drain();
        return;
      }
      const exists = [...this.foreground, ...this.background].some(existing =>
        existing?.kind === job.kind && existing.mangaId === job.mangaId,
      );
      if (exists) return;
    }
    if (job.kind === 'cache-chapter-images' && job.mangaId && job.chapterId) {
      if (this.currentJob?.kind === 'cache-chapter-images'
        && this.currentJob.mangaId === job.mangaId
        && this.currentJob.chapterId === job.chapterId) return;
      if (this.promoteQueuedChapterImageJob(job)) {
        this.drain();
        return;
      }
      const exists = [...this.foreground, ...this.imageBacklog].some(existing =>
        existing?.kind === 'cache-chapter-images'
        && existing.mangaId === job.mangaId
        && existing.chapterId === job.chapterId,
      );
      if (exists) return;
    }
    queue.push(job);
    this.drain();
  }

  private promoteQueuedMangaJob(job: CacheJob): boolean {
    if (job.priority !== 'foreground' || (job.kind !== 'cache-manga-detail' && job.kind !== 'cache-chapters') || !job.mangaId) return false;
    const foregroundIndex = this.foreground.findIndex(existing =>
      existing.kind === job.kind && existing.mangaId === job.mangaId,
    );
    if (foregroundIndex !== -1) return true;
    const backgroundIndex = this.background.findIndex(existing =>
      existing.kind === job.kind && existing.mangaId === job.mangaId,
    );
    if (backgroundIndex === -1) return false;
    const [existing] = this.background.splice(backgroundIndex, 1);
    this.foreground.push({ ...existing, priority: 'foreground', reason: job.reason });
    console.log(`[cache] job-promoted kind=${job.kind} manga=${job.mangaId} reason=${job.reason}`);
    return true;
  }

  private promoteQueuedChapterImageJob(job: CacheJob): boolean {
    if (job.priority !== 'foreground' || job.kind !== 'cache-chapter-images' || !job.mangaId || !job.chapterId) return false;
    const foregroundIndex = this.foreground.findIndex(existing =>
      existing.kind === 'cache-chapter-images'
      && existing.mangaId === job.mangaId
      && existing.chapterId === job.chapterId,
    );
    if (foregroundIndex !== -1) return true;
    const backlogIndex = this.imageBacklog.findIndex(existing =>
      existing.kind === 'cache-chapter-images'
      && existing.mangaId === job.mangaId
      && existing.chapterId === job.chapterId,
    );
    if (backlogIndex === -1) return false;
    const [existing] = this.imageBacklog.splice(backlogIndex, 1);
    this.foreground.push({
      ...existing,
      priority: 'foreground',
      chapterNumber: job.chapterNumber ?? existing.chapterNumber,
      chapterUrl: job.chapterUrl ?? existing.chapterUrl,
      reason: job.reason,
    });
    console.log(`[cache] job-promoted kind=cache-chapter-images manga=${job.mangaId} chapter=${job.chapterId} reason=${job.reason}`);
    return true;
  }

  private nextJob(): CacheJob | null {
    return this.foreground.shift() ?? this.background.shift() ?? this.imageBacklog.shift() ?? null;
  }

  private drain(): void {
    if (this.active) return;
    this.active = true;
    void this.runLoop().finally(() => {
      this.active = false;
      this.currentJob = null;
    });
  }

  private async runLoop(): Promise<void> {
    while (true) {
      const job = this.nextJob();
      if (!job) return;
      this.currentJob = job;
      const start = Date.now();
      try {
        if (job.kind === 'seed-newest') await this.seedNewest(job);
        else if (job.kind === 'cache-manga-detail' && job.mangaId) await this.cacheMangaDetail(job.mangaId, job);
        else if (job.kind === 'cache-chapters' && job.mangaId) await this.cacheChapters(job.mangaId, job);
        else if (job.kind === 'cache-chapter-images' && job.mangaId && job.chapterId) await this.cacheChapterImages(job.mangaId, job.chapterId, job);
        console.log(`[cache] job-done kind=${job.kind} manga=${job.mangaId ?? 'none'} reason=${job.reason} ${Date.now() - start}ms`);
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        console.log(`[cache] job-failed kind=${job.kind} manga=${job.mangaId ?? 'none'} reason=${job.reason} ${Date.now() - start}ms ${msg}`);
      }
    }
  }

  private async seedNewest(job: CacheJob): Promise<void> {
    const url = `${COMIX_API_BASE}/manga?page=1&limit=${NEWEST_LIMIT}&order%5Bchapter_updated_at%5D=desc`;
    const start = Date.now();
    const { data, meta } = await proxyFetchJson(url, { cloudflareProtected: true });
    const items = resultItems(data);
    this.db.setMeta('newest-page-1', JSON.stringify(data));

    let queued = 0;
    for (const item of items) {
      const mangaId = mangaIdFromItem(item);
      if (!mangaId) continue;
      this.db.upsertManga(mangaId, item);
      this.enqueue({ kind: 'cache-manga-detail', priority: 'background', mangaId, reason: job.reason });
      this.enqueue({ kind: 'cache-chapters', priority: 'background', mangaId, reason: job.reason });
      queued++;
    }

    console.log(`[cache] seed-newest fetched=${items.length} queued=${queued} http=${meta.status} fetchMs=${Date.now() - start}`);
  }

  private async cacheMangaDetail(mangaId: string, job: CacheJob): Promise<void> {
    const existing = this.db.getManga(mangaId)?.data ?? null;
    if (!job.force && isMangaDetailPayload(existing)) {
      console.log(`[cache] manga-detail skip manga=${mangaId} reason=cached`);
      return;
    }

    const result = await this.browserSession.fetchMangaDetail(mangaId);
    this.db.upsertManga(mangaId, result.data);
    const detail = result.data && typeof result.data === 'object'
      ? (result.data as Record<string, unknown>).result
      : undefined;
    const r = detail && typeof detail === 'object' ? detail as Record<string, unknown> : {};
    const recommendations = Array.isArray(r.recommendations) ? r.recommendations.length : 0;
    const tags = Array.isArray(r.tags) ? r.tags.length : 0;
    const genres = Array.isArray(r.genres) ? r.genres.length : 0;
    const description = Boolean(r.synopsis || r.description);
    console.log(`[cache] manga-detail cached manga=${mangaId} recommendations=${recommendations} genres=${genres} tags=${tags} description=${description} fetchMs=${result.durationMs}`);
  }

  private async cacheChapters(mangaId: string, job: CacheJob): Promise<void> {
    if (!job.force && this.db.getChapterList(mangaId)) {
      console.log(`[cache] chapters skip manga=${mangaId} reason=cached`);
      return;
    }

    const first = await this.fetchChapterPage(mangaId, 1);
    const pagination = resultPagination(first);
    const lastPage = Number(pagination.last_page ?? pagination.lastPage ?? 1);
    const allItems = [...resultItems(first)];
    let failed = 0;

    for (let page = 2; page <= lastPage; page++) {
      if (this.foreground.length > 0 && job.priority === 'background') {
        this.enqueue({ kind: 'cache-chapters', priority: 'background', mangaId, reason: 'resume-after-foreground' });
        console.log(`[cache] chapters yield manga=${mangaId} nextForeground=${this.foreground.length}`);
        return;
      }
      try {
        const data = await this.fetchChapterPage(mangaId, page);
        allItems.push(...resultItems(data));
      } catch (e) {
        failed++;
        const msg = (e as Error)?.message ?? String(e);
        console.log(`[cache] chapters page-failed manga=${mangaId} page=${page}/${lastPage} ${msg}`);
      }
    }

    const cached = {
      status: 'ok',
      result: {
        items: allItems,
        pagination: {
          ...pagination,
          current_page: 1,
          page: 1,
          last_page: lastPage,
          lastPage,
          total: Number(pagination.total ?? allItems.length),
        },
      },
    };
    this.db.upsertChapterList(mangaId, cached, failed > 0 ? 'partial' : 'ready');
    this.enqueueChapterImageJobs(mangaId, allItems, job.reason);
    console.log(`[cache] chapters cached manga=${mangaId} pages=${lastPage} items=${allItems.length} failed=${failed}`);
  }

  private async fetchChapterPage(mangaId: string, page: number): Promise<unknown> {
    const url = `${COMIX_API_BASE}/manga/${mangaId}/chapters?limit=${CHAPTER_PAGE_SIZE}&page=${page}&order%5Bnumber%5D=desc`;
    const result = await this.browserSession.signedFetch(url, mangaId, `https://comix.to/title/${mangaId}`);
    return result.data;
  }

  private enqueueChapterImageJobs(mangaId: string, chapters: unknown[], reason: string): void {
    let queued = 0;
    for (const chapter of chapters) {
      const chapterId = chapterIdFromItem(chapter);
      if (!chapterId || this.getChapterImages(mangaId, chapterId)) continue;
      const chapterNumber = chapterNumberFromItem(chapter);
      this.enqueue({
        kind: 'cache-chapter-images',
        priority: 'background',
        mangaId,
        chapterId,
        chapterNumber,
        chapterUrl: chapterUrlFromItem(chapter, mangaId, chapterId, chapterNumber),
        reason,
      });
      queued++;
    }
    console.log(`[cache] chapter-images queued manga=${mangaId} queued=${queued}`);
  }

  private recoverImageBacklogFromChapterCache(reason: string): void {
    const chapterLists = this.db.getAllChapterLists();
    let queued = 0;
    let chapters = 0;
    for (const chapterList of chapterLists) {
      const items = resultItems(chapterList.data);
      chapters += items.length;
      const before = this.imageBacklog.length;
      this.enqueueChapterImageJobs(chapterList.mangaId, items, reason);
      queued += this.imageBacklog.length - before;
    }
    console.log(`[cache] recovery chapter-lists=${chapterLists.length} chapters=${chapters} imageJobs=${queued}`);
  }

  private async cacheChapterImages(mangaId: string, chapterId: string, job: CacheJob): Promise<void> {
    if (!job.force && this.getChapterImages(mangaId, chapterId)) {
      console.log(`[cache] chapter-images skip manga=${mangaId} chapter=${chapterId} reason=cached`);
      return;
    }

    const start = Date.now();
    const url = `${COMIX_API_BASE}/chapters/${chapterId}`;
    const signingPageUrl = job.chapterUrl ?? `https://comix.to/title/${mangaId}/${chapterId}`;
    const result = await this.browserSession.signedFetch(url, mangaId, signingPageUrl);
    const pages = resultPages(result.data);
    const readiness = chapterImageReadiness(result.data);
    let candidates = 0;
    this.db.transaction(() => {
      for (const page of pages) {
        const imageUrl = pageImageUrl(page);
        if (!imageUrl) continue;
        for (const candidateUrl of imageStoreCandidates(imageUrl)) {
          this.db.observeImageCandidate(imageUrl, candidateUrl);
          candidates++;
        }
      }
      this.db.upsertChapterImages(mangaId, chapterId, result.data, readiness.ready ? 'ready' : 'empty');
    });
    console.log(`[cache] chapter-images cached manga=${mangaId} chapter=${chapterId} status=${readiness.ready ? 'ready' : 'empty'} pages=${pages.length} targetCount=${readiness.targetCount ?? 'unknown'} source=${readiness.source} candidates=${candidates} fetchMs=${result.durationMs} totalMs=${Date.now() - start}`);
  }
}
