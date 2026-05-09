import type { BrowserSession } from '../services/BrowserSession.js';
import { learnStoreHostFromUrl, listStoreHosts } from '../utils/storeHosts.js';
import { proxyFetchJson } from '../utils/proxyFetch.js';
import { CacheDatabase, type CacheJobEnqueueResult, type ImageStoreObservation } from './sqlite.js';
import { DurableJobScheduler, type CacheJobPriorityName } from './DurableJobScheduler.js';
import type { ByteCacheService } from './ByteCacheService.js';

const COMIX_API_BASE = 'https://comix.to/api/v1';
const NEWEST_LIMIT = 100;
const CHAPTER_PAGE_SIZE = 100;
const RECONCILE_PAGE_BUDGET = 5;
const CACHE_WORKER_ID = 'cache-service';
const DATA_CACHE_JOB_KINDS = ['seed-newest', 'crawl-search-page', 'cache-manga-detail', 'cache-chapters', 'reconcile-chapters', 'cache-chapter-page-map'];
const CACHE_DAY_ROLLOVER_HOUR = 4;
const CACHE_DAY_ROLLOVER_MINUTE = 45;

type CacheJobKind = 'seed-newest' | 'crawl-search-page' | 'cache-manga-detail' | 'cache-chapters' | 'reconcile-chapters' | 'cache-chapter-page-map';
export type CacheJobPriority = 'foreground' | 'observed' | 'daily' | 'background';
export type CacheReconcileSource = 'search-result' | 'manga-open' | 'manual-refresh';

export interface CacheReconcileResult {
  status: 'fresh' | 'queued' | 'promoted' | 'warming' | 'ignored';
  mangaId: string;
  cachedMax: number | null;
  observedLatestChapter: number | null;
  action: 'none' | 'reconcile' | 'full-refresh';
  reason: string;
}

export interface CacheMangaCardSnapshot {
  mangaId: string;
  manga: unknown | null;
  chapters: unknown | null;
  mangaReady: boolean;
  chaptersReady: boolean;
}

interface CacheJob {
  kind: CacheJobKind;
  priority: CacheJobPriority;
  mangaId?: string;
  chapterId?: string;
  chapterNumber?: number;
  chapterUrl?: string;
  page?: number;
  crawlDate?: string;
  observedLatestChapter?: number;
  source?: CacheReconcileSource;
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

function chapterSummary(chapters: unknown[]): { max: number | null; topId: string | null } {
  let max: number | null = null;
  let topId: string | null = null;
  for (const chapter of chapters) {
    const number = chapterNumberFromItem(chapter);
    if (number == null) continue;
    if (max == null || number > max) {
      max = number;
      topId = chapterIdFromItem(chapter);
    }
  }
  return { max, topId };
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

function collectSearchThumbnailUrls(data: unknown): string[] {
  const urls = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (/^https?:\/\//.test(value) && /\.(?:jpg|jpeg|png|webp)(?:[?#].*)?$/i.test(value)) {
        urls.add(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const child of Object.values(value as Record<string, unknown>)) visit(child);
    }
  };
  visit(data);
  return [...urls];
}

export class CacheService {
  private readonly db = new CacheDatabase();
  private readonly scheduler = new DurableJobScheduler(this.db);
  private active = false;
  private started = false;
  private currentJob: CacheJob | null = null;
  private dailyRolloverTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly browserSession: BrowserSession, private readonly byteCache: ByteCacheService | null = null) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduler.recoverWorker(CACHE_WORKER_ID);
    this.startDailyNewestCrawl();
    this.scheduleDailyRollover();
  }

  stop(): void {
    if (this.dailyRolloverTimer) {
      clearTimeout(this.dailyRolloverTimer);
      this.dailyRolloverTimer = null;
    }
    this.db.close();
  }

  status(): Record<string, unknown> {
    return {
      started: this.started,
      active: this.active,
      currentJob: this.currentJob,
      durableJobs: this.scheduler.counts(),
      counts: this.db.counts(),
    };
  }

  getManga(mangaId: string): unknown | null {
    const data = this.db.getManga(mangaId)?.data ?? null;
    return isMangaDetailPayload(data) ? data : null;
  }

  getChapterList(mangaId: string): unknown | null {
    if (this.isChapterListWarming(mangaId)) {
      console.log(`[cache] chapters warming manga=${mangaId} reason=repair-active`);
      return null;
    }
    return this.db.getChapterList(mangaId)?.data ?? null;
  }

  isChapterListWarming(mangaId: string): boolean {
    return this.hasChapterRepairWork(mangaId);
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

  getMangaCardSnapshots(mangaIds: string[], options: { includeChapters?: boolean } = {}): CacheMangaCardSnapshot[] {
    const includeChapters = options.includeChapters === true;
    const seen = new Set<string>();
    const snapshots: CacheMangaCardSnapshot[] = [];
    for (const mangaId of mangaIds) {
      if (seen.has(mangaId)) continue;
      seen.add(mangaId);
      const manga = this.getManga(mangaId);
      const chapters = includeChapters ? this.getChapterList(mangaId) : null;
      if (!manga) this.warmManga(mangaId, 'favorite-card-cache-miss');
      snapshots.push({
        mangaId,
        manga,
        chapters,
        mangaReady: manga != null,
        chaptersReady: includeChapters ? chapters != null : false,
      });
    }
    console.log(`[cache] manga-card-snapshots requested=${mangaIds.length} unique=${seen.size} includeChapters=${includeChapters} mangaReady=${snapshots.filter(item => item.mangaReady).length} chaptersReady=${snapshots.filter(item => item.chaptersReady).length}`);
    return snapshots;
  }

  refreshManga(mangaId: string, reason = 'frontend-refresh'): void {
    this.db.invalidateChapterList(mangaId);
    this.enqueue({ kind: 'cache-manga-detail', priority: 'foreground', mangaId, force: true, reason });
    this.enqueue({ kind: 'cache-chapters', priority: 'foreground', mangaId, force: true, reason });
  }

  reconcileManga(mangaId: string, observedLatestChapter: number | null, priority: CacheJobPriority, source: CacheReconcileSource): CacheReconcileResult {
    const normalizedPriority = priority === 'foreground' ? 'foreground' : 'observed';
    const cached = this.db.getChapterList(mangaId);
    const cachedItems = cached ? resultItems(cached.data) : [];
    const { max: cachedMax } = chapterSummary(cachedItems);
    const observed = typeof observedLatestChapter === 'number' && Number.isFinite(observedLatestChapter) && observedLatestChapter > 0
      ? observedLatestChapter
      : null;

    if (!cached) {
      this.enqueue({ kind: 'cache-manga-detail', priority: normalizedPriority, mangaId, reason: `reconcile-missing-cache:${source}` });
      this.enqueue({ kind: 'cache-chapters', priority: normalizedPriority, mangaId, reason: `reconcile-missing-cache:${source}` });
      console.log(`[cache] reconcile decision manga=${mangaId} source=${source} priority=${normalizedPriority} cachedMax=none observed=${observed ?? 'unknown'} action=full-refresh status=queued reason=missing-cache`);
      return { status: 'queued', mangaId, cachedMax: null, observedLatestChapter: observed, action: 'full-refresh', reason: 'missing-cache' };
    }

    if (observed == null) {
      console.log(`[cache] reconcile decision manga=${mangaId} source=${source} priority=${normalizedPriority} cachedMax=${cachedMax ?? 'unknown'} observed=invalid action=none status=ignored reason=invalid-observed`);
      return { status: 'ignored', mangaId, cachedMax, observedLatestChapter: null, action: 'none', reason: 'invalid-observed' };
    }

    if (cachedMax != null && cachedMax >= observed) {
      console.log(`[cache] reconcile decision manga=${mangaId} source=${source} priority=${normalizedPriority} cachedMax=${cachedMax} observed=${observed} action=none status=fresh reason=cached-up-to-date`);
      return { status: 'fresh', mangaId, cachedMax, observedLatestChapter: observed, action: 'none', reason: 'cached-up-to-date' };
    }

    const status = this.enqueue({
      kind: 'reconcile-chapters',
      priority: normalizedPriority,
      mangaId,
      observedLatestChapter: observed,
      source,
      reason: `stale-cache:${source}`,
    });
    console.log(`[cache] reconcile decision manga=${mangaId} source=${source} priority=${normalizedPriority} cachedMax=${cachedMax ?? 'unknown'} observed=${observed} action=reconcile status=${status} reason=stale-cache`);
    return { status: status === 'promoted' ? 'promoted' : 'queued', mangaId, cachedMax, observedLatestChapter: observed, action: 'reconcile', reason: 'stale-cache' };
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
    this.enqueue({ kind: 'cache-chapter-page-map', priority: 'foreground', mangaId, chapterId, chapterNumber, chapterUrl, force: true, reason });
  }

  warmChapterImages(mangaId: string, chapterId: string, chapterNumber?: number, chapterUrl?: string, reason = 'cache-miss'): void {
    this.enqueue({ kind: 'cache-chapter-page-map', priority: 'foreground', mangaId, chapterId, chapterNumber, chapterUrl, reason });
  }

  private enqueue(job: CacheJob): CacheJobEnqueueResult {
    if ((job.kind === 'cache-manga-detail' || job.kind === 'cache-chapters' || job.kind === 'reconcile-chapters') && job.mangaId) {
      if (this.currentJob?.kind === job.kind && this.currentJob.mangaId === job.mangaId) return 'existing';
      if (job.kind === 'reconcile-chapters') {
        const fullJob = this.scheduler.jobsForResource('cache-chapters', job.mangaId)[0];
        if (fullJob) {
          if (job.priority === 'foreground' && fullJob.priority < 1000) {
            const payload = payloadObject(fullJob.payload);
            const status = this.enqueueDurable({
              kind: 'cache-chapters',
              priority: 'foreground',
              mangaId: job.mangaId,
              force: payload.force === true,
              reason: job.reason,
            });
            console.log(`[cache] job-promoted kind=cache-chapters manga=${job.mangaId} from=reconcile-conflict to=foreground reason=${job.reason}`);
            this.drain();
            return status === 'existing' ? 'promoted' : status;
          }
          return 'existing';
        }
      }
    }
    if (job.kind === 'cache-chapter-page-map' && job.mangaId && job.chapterId) {
      if (this.currentJob?.kind === 'cache-chapter-page-map'
        && this.currentJob.mangaId === job.mangaId
        && this.currentJob.chapterId === job.chapterId) return 'existing';
    }
    const status = this.enqueueDurable(job);
    this.drain();
    return status;
  }

  private enqueueDurable(job: CacheJob): CacheJobEnqueueResult {
    const resourceKey = this.resourceKey(job);
    if (!resourceKey) return 'existing';
    const payload = {
      priority: job.priority,
      mangaId: job.mangaId,
      chapterId: job.chapterId,
      chapterNumber: job.chapterNumber,
      chapterUrl: job.chapterUrl,
      page: job.page,
      crawlDate: job.crawlDate,
      observedLatestChapter: job.observedLatestChapter,
      source: job.source,
      force: job.force,
      reason: job.reason,
    };
    return this.scheduler.enqueueUnique({
      kind: job.kind,
      resourceKey,
      priority: this.schedulerPriority(job.priority),
      payload,
      maxAttempts: job.kind === 'cache-chapter-page-map' ? 5 : 3,
    });
  }

  private nextJob() {
    return this.scheduler.claimNext(CACHE_WORKER_ID, 30 * 60 * 1000, DATA_CACHE_JOB_KINDS);
  }

  private hasChapterRepairWork(mangaId: string): boolean {
    const isRepair = (job: CacheJob | null | undefined) =>
      job != null
      && job.mangaId === mangaId
      && (job.kind === 'reconcile-chapters' || (job.kind === 'cache-chapters' && job.force === true));
    return isRepair(this.currentJob)
      || this.scheduler.jobsByKinds(['reconcile-chapters', 'cache-chapters'])
        .some(record => isRepair(this.recordToJob(record)));
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
      const record = this.nextJob();
      if (!record) return;
      const job = this.recordToJob(record);
      this.currentJob = job;
      const start = Date.now();
      try {
        if (job.kind === 'seed-newest') await this.seedNewest(job);
        else if (job.kind === 'crawl-search-page') await this.crawlSearchPage(job);
        else if (job.kind === 'cache-manga-detail' && job.mangaId) await this.cacheMangaDetail(job.mangaId, job);
        else if (job.kind === 'cache-chapters' && job.mangaId) await this.cacheChapters(job.mangaId, job);
        else if (job.kind === 'reconcile-chapters' && job.mangaId) await this.reconcileChapters(job.mangaId, job);
        else if (job.kind === 'cache-chapter-page-map' && job.mangaId && job.chapterId) await this.cacheChapterPageMap(job.mangaId, job.chapterId, job);
        this.scheduler.complete(record);
        console.log(`[cache] job-done kind=${job.kind} manga=${job.mangaId ?? 'none'} reason=${job.reason} ${Date.now() - start}ms`);
      } catch (e) {
        const msg = conciseError((e as Error)?.message ?? String(e));
        this.scheduler.retry(record, msg, this.retryDelayMs(record.attempts));
        console.log(`[cache] job-failed kind=${job.kind} manga=${job.mangaId ?? 'none'} reason=${job.reason} ${Date.now() - start}ms ${msg}`);
      }
    }
  }

  private async seedNewest(job: CacheJob): Promise<void> {
    await this.crawlSearchPage({ ...job, kind: 'crawl-search-page', page: 1 });
  }

  private startDailyNewestCrawl(): void {
    const crawlDate = todayKey();
    if (this.db.getMeta(`crawl-search-newest:${crawlDate}:complete`) === '1') {
      console.log(`[cache] start daily-crawl date=${crawlDate} action=already-complete`);
      return;
    }

    const existing = this.crawlSearchJobsForDate(crawlDate);
    if (existing.length > 0) {
      console.log(`[cache] start daily-crawl date=${crawlDate} action=resume-existing jobs=${existing.length}`);
      this.drain();
      return;
    }

    const demoted = this.demoteOlderSearchCrawls(crawlDate);
    const lastPage = Number(this.db.getMeta(`crawl-search-newest:${crawlDate}:last-page`) ?? 0);
    const page = Number.isFinite(lastPage) && lastPage > 0 ? lastPage + 1 : 1;
    this.enqueue({ kind: 'crawl-search-page', priority: 'daily', page, crawlDate, reason: 'startup' });
    console.log(`[cache] start daily-crawl date=${crawlDate} action=enqueue page=${page} demotedOldCrawls=${demoted}`);
  }

  private scheduleDailyRollover(): void {
    if (this.dailyRolloverTimer) clearTimeout(this.dailyRolloverTimer);
    const delayMs = msUntilNextCacheDayRollover();
    this.dailyRolloverTimer = setTimeout(() => {
      this.dailyRolloverTimer = null;
      const crawlDate = todayKey();
      console.log(`[cache] daily-rollover date=${crawlDate}`);
      this.startDailyNewestCrawl();
      this.scheduleDailyRollover();
    }, delayMs);
    this.dailyRolloverTimer.unref?.();
    console.log(`[cache] daily-rollover scheduled delayMs=${delayMs}`);
  }

  private async crawlSearchPage(job: CacheJob): Promise<void> {
    const page = job.page ?? 1;
    const crawlDate = job.crawlDate ?? todayKey();
    const reason = job.reason;
    const url = `${COMIX_API_BASE}/manga?page=${page}&limit=${NEWEST_LIMIT}&order%5Bchapter_updated_at%5D=desc`;
    const start = Date.now();
    const { data, meta } = await proxyFetchJson(url, { cloudflareProtected: true });
    const items = resultItems(data);
    const pagination = resultPagination(data);
    const lastPage = Number(pagination.last_page ?? pagination.lastPage ?? page);
    this.db.setMeta(`newest-page-${page}`, JSON.stringify(data));
    this.db.setMeta(`crawl-search-newest:${crawlDate}:last-page`, String(page));

    let queued = 0;
    let thumbnailDiscovered = 0;
    let thumbnailQueued = 0;
    for (const item of items) {
      const mangaId = mangaIdFromItem(item);
      if (!mangaId) continue;
      this.db.upsertManga(mangaId, item);
      const thumbnailJobs = this.enqueueSearchThumbnailJobs(item, 'search-newest', 'daily');
      thumbnailDiscovered += thumbnailJobs.discovered;
      thumbnailQueued += thumbnailJobs.queued;
      this.enqueue({ kind: 'cache-manga-detail', priority: 'background', mangaId, reason });
      this.enqueue({ kind: 'cache-chapters', priority: 'background', mangaId, reason });
      queued++;
    }

    const hasNext = page < lastPage && items.length > 0;
    const otherFrontierExists = this.hasOtherCrawlSearchJob(crawlDate, page);
    if (hasNext && !otherFrontierExists) {
      this.enqueue({
        kind: 'crawl-search-page',
        priority: 'daily',
        page: page + 1,
        crawlDate,
        reason: `crawl-next:${crawlDate}`,
      });
    } else if (!hasNext) {
      this.db.setMeta(`crawl-search-newest:${crawlDate}:complete`, '1');
    }

    const next = hasNext
      ? otherFrontierExists ? 'existing-frontier' : page + 1
      : 'none';
    console.log(`[cache] search-crawl page=${page}/${lastPage} date=${crawlDate} fetched=${items.length} queuedManga=${queued} thumbnails=${thumbnailDiscovered} queuedThumbnails=${thumbnailQueued} next=${next} http=${meta.status} fetchMs=${Date.now() - start}`);
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

  private crawlSearchJobsForDate(crawlDate: string): CacheJob[] {
    return this.scheduler.jobsByKinds(['crawl-search-page'])
      .map(record => this.recordToJob(record))
      .filter(job => job.crawlDate === crawlDate);
  }

  private demoteOlderSearchCrawls(crawlDate: string): number {
    let demoted = 0;
    for (const record of this.scheduler.jobsByKinds(['crawl-search-page'])) {
      const job = this.recordToJob(record);
      if (job.crawlDate === crawlDate || record.priority <= 10) continue;
      this.scheduler.updatePriority(record, 'background');
      demoted++;
    }
    return demoted;
  }

  private hasOtherCrawlSearchJob(crawlDate: string, currentPage: number): boolean {
    return this.crawlSearchJobsForDate(crawlDate)
      .some(job => job.page !== currentPage);
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
      if (this.scheduler.runnableCountAbove('background') > 0 && job.priority === 'background') {
        this.enqueue({ kind: 'cache-chapters', priority: 'background', mangaId, reason: 'resume-after-foreground' });
        console.log(`[cache] chapters yield manga=${mangaId} higherPriorityJobs=${this.scheduler.runnableCountAbove('background')}`);
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
    const pageMapJobs = this.enqueueChapterPageMapJobs(mangaId, allItems, 'chapter-list-cached');
    console.log(`[cache] chapters cached manga=${mangaId} pages=${lastPage} items=${allItems.length} failed=${failed} pageMapJobs=${pageMapJobs.queued}/${pageMapJobs.discovered}`);
  }

  private async reconcileChapters(mangaId: string, job: CacheJob): Promise<void> {
    const cached = this.db.getChapterList(mangaId);
    if (!cached) {
      console.log(`[cache] reconcile missing-cache manga=${mangaId} priority=${job.priority} source=${job.source ?? 'unknown'} action=full-refresh`);
      this.enqueue({ kind: 'cache-chapters', priority: job.priority, mangaId, force: true, reason: 'reconcile-missing-cache' });
      return;
    }

    const cachedItems = resultItems(cached.data);
    const cachedIds = new Set(cachedItems.map(chapterIdFromItem).filter((id): id is string => id != null));
    const { max: previousMax } = chapterSummary(cachedItems);
    const observed = job.observedLatestChapter;
    if (observed != null && previousMax != null && previousMax >= observed) {
      console.log(`[cache] reconcile fresh-at-run manga=${mangaId} cachedMax=${previousMax} observed=${observed} priority=${job.priority}`);
      return;
    }

    const newItems: unknown[] = [];
    let reachedExisting = false;
    let fetchedPages = 0;
    let lastPagination: Record<string, unknown> = resultPagination(cached.data);

    for (let page = 1; page <= RECONCILE_PAGE_BUDGET; page++) {
      const data = await this.fetchChapterPage(mangaId, page);
      fetchedPages++;
      lastPagination = resultPagination(data);
      const items = resultItems(data);
      let pageNew = 0;
      for (const item of items) {
        const id = chapterIdFromItem(item);
        const number = chapterNumberFromItem(item);
        if (id && cachedIds.has(id)) {
          reachedExisting = true;
          break;
        }
        if (previousMax != null && number != null && number <= previousMax) {
          reachedExisting = true;
          break;
        }
        if (!id || cachedIds.has(id)) continue;
        cachedIds.add(id);
        newItems.push(item);
        pageNew++;
      }
      console.log(`[cache] reconcile page manga=${mangaId} page=${page} items=${items.length} new=${pageNew} reachedExisting=${reachedExisting} cachedMax=${previousMax ?? 'unknown'} observed=${observed ?? 'unknown'}`);
      if (reachedExisting) break;
    }

    if (!reachedExisting && fetchedPages >= RECONCILE_PAGE_BUDGET) {
      this.enqueue({ kind: 'cache-chapters', priority: job.priority, mangaId, force: true, reason: 'reconcile-budget-exceeded' });
      console.log(`[cache] reconcile fallback manga=${mangaId} pages=${fetchedPages} new=${newItems.length} action=full-refresh reason=budget-exceeded`);
      return;
    }

    if (newItems.length === 0) {
      console.log(`[cache] reconcile no-new-items manga=${mangaId} cachedMax=${previousMax ?? 'unknown'} observed=${observed ?? 'unknown'} pages=${fetchedPages}`);
      return;
    }

    const mergedItems = [...newItems, ...cachedItems]
      .sort((a, b) => (chapterNumberFromItem(b) ?? -Infinity) - (chapterNumberFromItem(a) ?? -Infinity));
    const { max: nextMax } = chapterSummary(mergedItems);
    const cachedRoot = cached.data && typeof cached.data === 'object'
      ? cached.data as Record<string, unknown>
      : {};
    const cachedResult = cachedRoot.result && typeof cachedRoot.result === 'object'
      ? cachedRoot.result as Record<string, unknown>
      : {};
    const merged = {
      ...cachedRoot,
      status: 'ok',
      result: {
        ...cachedResult,
        items: mergedItems,
        pagination: {
          ...lastPagination,
          current_page: 1,
          page: 1,
          total: Math.max(Number(lastPagination.total ?? 0), mergedItems.length),
        },
      },
    };

    this.db.upsertChapterList(mangaId, merged, cached.status === 'partial' ? 'partial' : 'ready');
    const pageMapJobs = this.enqueueChapterPageMapJobs(mangaId, newItems, 'chapter-reconcile-new');
    console.log(`[cache] reconcile merged manga=${mangaId} previousCount=${cachedItems.length} nextCount=${mergedItems.length} previousMax=${previousMax ?? 'unknown'} nextMax=${nextMax ?? 'unknown'} new=${newItems.length} pages=${fetchedPages} pageMapJobs=${pageMapJobs.queued}/${pageMapJobs.discovered}`);
  }

  private async fetchChapterPage(mangaId: string, page: number): Promise<unknown> {
    const url = `${COMIX_API_BASE}/manga/${mangaId}/chapters?limit=${CHAPTER_PAGE_SIZE}&page=${page}&order%5Bnumber%5D=desc`;
    const result = await this.browserSession.signedFetch(url, mangaId, `https://comix.to/title/${mangaId}`);
    return result.data;
  }

  private enqueueSearchThumbnailJobs(data: unknown, reason: string, priority: CacheJobPriorityName): { discovered: number; queued: number } {
    const urls = collectSearchThumbnailUrls(data);
    let queued = 0;
    for (const url of urls) {
      const status = this.byteCache
        ? this.byteCache.warm(url, 'https://comix.to', priority, reason)
        : this.scheduler.enqueueUnique({
            kind: 'cache-byte',
            resourceKey: url,
            priority,
            payload: {
              sourceUrl: url,
              referer: 'https://comix.to',
              reason,
            },
            maxAttempts: 5,
          });
      if (status === 'queued' || status === 'promoted') queued++;
    }
    return { discovered: urls.length, queued };
  }

  private enqueueChapterPageMapJobs(mangaId: string, chapters: unknown[], reason: string): { discovered: number; queued: number } {
    let discovered = 0;
    let queued = 0;
    for (const chapter of chapters) {
      const chapterId = chapterIdFromItem(chapter);
      if (!chapterId) continue;
      discovered++;
      if (this.db.getChapterImages(mangaId, chapterId)) continue;
      const chapterNumber = chapterNumberFromItem(chapter);
      const chapterUrl = chapterUrlFromItem(chapter, mangaId, chapterId, chapterNumber);
      const status = this.enqueue({
        kind: 'cache-chapter-page-map',
        priority: 'background',
        mangaId,
        chapterId,
        chapterNumber,
        chapterUrl,
        reason,
      });
      if (status === 'queued' || status === 'promoted') queued++;
    }
    return { discovered, queued };
  }

  private async cacheChapterPageMap(mangaId: string, chapterId: string, job: CacheJob): Promise<void> {
    if (!job.force && this.getChapterImages(mangaId, chapterId)) {
      console.log(`[cache] chapter-page-map skip manga=${mangaId} chapter=${chapterId} reason=cached`);
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
    console.log(`[cache] chapter-page-map cached manga=${mangaId} chapter=${chapterId} status=${readiness.ready ? 'ready' : 'empty'} pages=${pages.length} targetCount=${readiness.targetCount ?? 'unknown'} source=${readiness.source} storeCandidates=${candidates} fetchMs=${result.durationMs} totalMs=${Date.now() - start}`);
  }

  private resourceKey(job: CacheJob): string | null {
    if (job.kind === 'seed-newest') return 'newest';
    if (job.kind === 'crawl-search-page') return `${job.crawlDate ?? todayKey()}:${job.page ?? 1}`;
    if (job.kind === 'cache-chapter-page-map') {
      return job.mangaId && job.chapterId ? `${job.mangaId}:${job.chapterId}` : null;
    }
    return job.mangaId ?? null;
  }

  private schedulerPriority(priority: CacheJobPriority): CacheJobPriorityName {
    return priority === 'foreground' ? 'foreground' : priority === 'observed' ? 'observed' : priority === 'daily' ? 'daily' : 'background';
  }

  private recordToJob(record: { kind: string; payload: unknown }): CacheJob {
    const payload = payloadObject(record.payload);
    return {
      kind: record.kind as CacheJobKind,
      priority: payload.priority === 'foreground' || payload.priority === 'observed' || payload.priority === 'daily' ? payload.priority : 'background',
      mangaId: stringOrUndefined(payload.mangaId),
      chapterId: stringOrUndefined(payload.chapterId),
      chapterNumber: numberOrUndefined(payload.chapterNumber),
      chapterUrl: stringOrUndefined(payload.chapterUrl),
      page: numberOrUndefined(payload.page),
      crawlDate: stringOrUndefined(payload.crawlDate),
      observedLatestChapter: numberOrUndefined(payload.observedLatestChapter),
      source: payload.source === 'search-result' || payload.source === 'manga-open' || payload.source === 'manual-refresh' ? payload.source : undefined,
      force: payload.force === true,
      reason: stringOrUndefined(payload.reason) ?? 'durable-job',
    };
  }

  private retryDelayMs(attempts: number): number {
    return Math.min(60_000, 1000 * Math.max(1, attempts));
  }
}

function payloadObject(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function conciseError(error: string): string {
  return error.split('\n')[0]?.trim().slice(0, 500) || 'unknown-error';
}

function todayKey(): string {
  const rolloverOffsetMs = ((CACHE_DAY_ROLLOVER_HOUR * 60) + CACHE_DAY_ROLLOVER_MINUTE) * 60 * 1000;
  const shifted = new Date(Date.now() - rolloverOffsetMs);
  const year = shifted.getFullYear();
  const month = String(shifted.getMonth() + 1).padStart(2, '0');
  const day = String(shifted.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function msUntilNextCacheDayRollover(): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(CACHE_DAY_ROLLOVER_HOUR, CACHE_DAY_ROLLOVER_MINUTE, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}
