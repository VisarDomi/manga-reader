import type { BrowserSession } from '../services/BrowserSession.js';
import { learnStoreHostFromUrl, listStoreHosts } from '../utils/storeHosts.js';
import { proxyFetchJson } from '../utils/proxyFetch.js';
import { DATA_CACHE_BACKGROUND_ENABLED } from '../config.js';
import { CacheDatabase, type CacheJobEnqueueResult, type ImageStoreObservation, type ImageStoreObservationRecord } from './sqlite.js';
import { CACHE_JOB_PRIORITY, DurableJobScheduler, type CacheJobPriorityName } from './DurableJobScheduler.js';
import type { ByteCacheService } from './ByteCacheService.js';
import type { ServerMangaProvider } from '../providers/types.js';
import { getServerProvider } from '../services/providerRuntime.js';

const DEFAULT_SEARCH_PAGE_SIZE = 100;
const CHAPTER_PAGE_SIZE = 100;
const RECONCILE_PAGE_BUDGET = 5;
const DATA_CACHE_JOB_KINDS = ['seed-newest', 'crawl-search-page', 'cache-manga-detail', 'cache-chapters', 'reconcile-chapters', 'cache-chapter-page-map'];
const CACHE_DAY_ROLLOVER_HOUR = 4;
const CACHE_DAY_ROLLOVER_MINUTE = 45;
const CRAWL_SEARCH_CONTRACT_VERSION = 'v3';
const FAILED_DATA_RETRY_MS = 6 * 60 * 60 * 1000;
const COVER_OWNERSHIP_REBUILD_VERSION = '1';
const STORE_OBSERVATION_LIMIT = 50_000;
const STORE_RANKING_TTL_MS = 30_000;
const STORE_RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
const STORE_EXPLOIT_RATE = 0.8;
const STORE_MIN_EXPLOIT_SAMPLES = 200;
const STORE_FALLBACK_FAILURE_PENALTY_MS = 12_000;
const STORE_TAIL_WEIGHTS = {
  p90: 0.25,
  p95: 0.4,
  p98: 0.35,
};
const VERBOSE_JOB_PRIORITY = CACHE_JOB_PRIORITY.observed;
const SLOW_BACKGROUND_JOB_MS = 5_000;
const BACKGROUND_FAILURE_SUMMARY_MS = 30_000;

type CacheJobKind = 'seed-newest' | 'crawl-search-page' | 'cache-manga-detail' | 'cache-chapters' | 'reconcile-chapters' | 'cache-chapter-page-map';
export type CacheJobPriority = 'interactive' | 'foreground' | 'observed' | 'daily' | 'background';
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
  requestedAt?: number;
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

interface WeightedLatencySample {
  value: number;
  weight: number;
}

interface StoreScore {
  host: string;
  attempts: number;
  score: number;
  p90: number;
  p95: number;
  p98: number;
  max: number;
}

interface StoreRanking {
  winnerHost: string | null;
  failurePenaltyMs: number;
  scores: StoreScore[];
  expiresAt: number;
}

interface BackgroundFailureSummary {
  provider: string;
  kind: CacheJobKind;
  mangaId: string;
  priority: CacheJobPriority;
  reason: string;
  error: string;
  firstAt: number;
  lastAt: number;
  count: number;
  runMsTotal: number;
  sampleIds: string[];
  timer: ReturnType<typeof setTimeout> | null;
}

class CacheJobYield extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CacheJobYield';
  }
}

function resultItems(data: unknown): unknown[] {
  if (!data || typeof data !== 'object') return [];
  const result = (data as Record<string, unknown>).result;
  if (!result || typeof result !== 'object') return [];
  const items = (result as Record<string, unknown>).items;
  return Array.isArray(items) ? items : [];
}

function uploadedAtFromRelativeLabel(label: unknown, referenceMs: number): number | null {
  if (typeof label !== 'string') return null;
  const text = label.trim().toLowerCase();
  const match = /^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|mo|mos|month|months|y|yr|yrs|year|years)(?:\s*ago)?$/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  const unit = match[2];
  const multipliers: Record<string, number> = {
    s: 1,
    sec: 1,
    secs: 1,
    second: 1,
    seconds: 1,
    m: 60,
    min: 60,
    mins: 60,
    minute: 60,
    minutes: 60,
    h: 60 * 60,
    hr: 60 * 60,
    hrs: 60 * 60,
    hour: 60 * 60,
    hours: 60 * 60,
    d: 24 * 60 * 60,
    day: 24 * 60 * 60,
    days: 24 * 60 * 60,
    w: 7 * 24 * 60 * 60,
    wk: 7 * 24 * 60 * 60,
    wks: 7 * 24 * 60 * 60,
    week: 7 * 24 * 60 * 60,
    weeks: 7 * 24 * 60 * 60,
    mo: 30 * 24 * 60 * 60,
    mos: 30 * 24 * 60 * 60,
    month: 30 * 24 * 60 * 60,
    months: 30 * 24 * 60 * 60,
    y: 365 * 24 * 60 * 60,
    yr: 365 * 24 * 60 * 60,
    yrs: 365 * 24 * 60 * 60,
    year: 365 * 24 * 60 * 60,
    years: 365 * 24 * 60 * 60,
  };
  const seconds = multipliers[unit];
  if (!seconds) return null;
  return Math.max(0, Math.floor(referenceMs / 1000) - (value * seconds));
}

function staticChapterListPayload(data: unknown, referenceMs = Date.now()): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const root = data as Record<string, unknown>;
  const result = root.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return data;
  const resultRoot = result as Record<string, unknown>;
  const items = resultRoot.items;
  if (!Array.isArray(items)) return data;
  return {
    ...root,
    result: {
      ...resultRoot,
      items: items.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
        const copy = { ...item as Record<string, unknown> };
        if (copy.created_at == null) {
          const uploadedAt = uploadedAtFromRelativeLabel(copy.createdAtFormatted, referenceMs);
          if (uploadedAt != null) copy.created_at = uploadedAt;
        }
        delete copy.createdAtFormatted;
        return copy;
      }),
    },
  };
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

function resultPages(data: unknown): unknown[] {
  if (!data || typeof data !== 'object') return [];
  const result = (data as Record<string, unknown>).result;
  if (!result || typeof result !== 'object') return [];
  const pages = (result as Record<string, unknown>).pages;
  return Array.isArray(pages) ? pages : [];
}

function chapterImageReadiness(data: unknown): { ready: boolean; pages: number; targetCount: number | null; source: string; schemaVersion: number | null; scrambleKnown: number } {
  const pages = resultPages(data);
  const result = data && typeof data === 'object'
    ? (data as Record<string, unknown>).result
    : undefined;
  const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  const schemaVersion = typeof record.schemaVersion === 'number' && Number.isFinite(record.schemaVersion)
    ? record.schemaVersion
    : null;
  const targetCount = typeof record.targetCount === 'number' && Number.isFinite(record.targetCount)
    ? record.targetCount
    : null;
  const source = typeof record.source === 'string' ? record.source : 'unknown';
  const populated = pages.filter(page => pageImageUrl(page)).length;
  const scrambleKnown = pages.filter(page => page && typeof page === 'object' && typeof (page as Record<string, unknown>).scramble === 'boolean').length;
  const ready = (source === 'runtime-http' || source.endsWith('-api'))
    && schemaVersion === 2
    && targetCount !== null
    && targetCount > 0
    && pages.length === targetCount
    && populated === targetCount
    && scrambleKnown === targetCount;
  return { ready, pages: pages.length, targetCount, source, schemaVersion, scrambleKnown };
}

function pageImageUrl(page: unknown): string | null {
  if (typeof page === 'string' && page.length > 0) return page;
  if (!page || typeof page !== 'object') return null;
  const r = page as Record<string, unknown>;
  const value = r.url ?? r.src ?? r.image ?? r.image_url;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function imageLogKey(imageUrl: string): string {
  try {
    const url = new URL(imageUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    return `${url.hostname}/${parts.slice(-2).join('/') || parts.at(-1) || 'unknown'}`;
  } catch {
    return imageUrl.slice(0, 120);
  }
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

function hostFromUrl(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function shuffled<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function weightedPercentile(samples: WeightedLatencySample[], percentile: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a.value - b.value);
  const totalWeight = sorted.reduce((sum, sample) => sum + sample.weight, 0);
  if (totalWeight <= 0) return sorted[sorted.length - 1]?.value ?? 0;
  const target = totalWeight * percentile;
  let seen = 0;
  for (const sample of sorted) {
    seen += sample.weight;
    if (seen >= target) return sample.value;
  }
  return sorted[sorted.length - 1]?.value ?? 0;
}

function withImageStoreCandidates(
  data: unknown,
  mangaId: string,
  chapterId: string,
  context: { chapterNumber?: number; chapterUrl?: string },
  candidateOrder: (imageUrl: string) => string[],
  criticalCandidateOrder: (imageUrl: string) => string[],
): unknown {
  if (!data || typeof data !== 'object') return data;
  const root = data as Record<string, unknown>;
  const result = root.result;
  if (!result || typeof result !== 'object') return data;
  const resultRecord = result as Record<string, unknown>;
  if (!Array.isArray(resultRecord.pages)) return data;

  return {
    ...root,
    result: {
      ...resultRecord,
      pages: resultRecord.pages.map((page, pageIndex) => {
        const imageUrl = pageImageUrl(page);
        if (!imageUrl || !page || typeof page !== 'object') return page;
        const record = page as Record<string, unknown>;
        if (record.scramble === true) {
          const params = new URLSearchParams();
          const chapterNumber = context.chapterNumber ?? resultRecord.chapterNumber;
          const chapterUrl = context.chapterUrl ?? resultRecord.chapterUrl;
          if (typeof chapterNumber === 'number' && Number.isFinite(chapterNumber)) params.set('number', String(chapterNumber));
          if (typeof chapterUrl === 'string' && chapterUrl.length > 0) params.set('url', chapterUrl);
          const preloadParams = new URLSearchParams(params);
          preloadParams.set('policy', 'preload');
          const criticalParams = new URLSearchParams(params);
          criticalParams.set('policy', 'critical');
          const decodedBaseUrl = `/api/cache/manga/${encodeURIComponent(mangaId)}/chapters/${encodeURIComponent(chapterId)}/pages/${pageIndex}/decoded`;
          return {
            ...record,
            candidates: [`${decodedBaseUrl}?${preloadParams}`],
            criticalCandidates: [`${decodedBaseUrl}?${criticalParams}`],
          };
        }
        return {
          ...record,
          candidates: candidateOrder(imageUrl),
          criticalCandidates: criticalCandidateOrder(imageUrl),
        };
      }),
    },
  };
}

function coverUrlFromItem(data: unknown, variant: 'card' | 'detail'): string | null {
  if (!data || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  const directCover = raw.cover;
  if (typeof directCover === 'string' && directCover.length > 0) return directCover;
  const photo = raw.photo;
  if (typeof photo === 'string' && photo.length > 0) return photo;
  const poster = raw.poster && typeof raw.poster === 'object'
    ? raw.poster as Record<string, unknown>
    : {};
  const preferred = variant === 'detail'
    ? poster.large ?? poster.medium ?? poster.small
    : poster.medium ?? poster.large ?? poster.small;
  return typeof preferred === 'string' && preferred.length > 0 ? preferred : null;
}

export class CacheService {
  private readonly db: CacheDatabase;
  private readonly scheduler: DurableJobScheduler;
  private readonly workerId: string;
  private active = false;
  private started = false;
  private currentJob: CacheJob | null = null;
  private dailyRolloverTimer: ReturnType<typeof setTimeout> | null = null;
  private storeRanking: StoreRanking | null = null;
  private readonly backgroundFailures = new Map<string, BackgroundFailureSummary>();
  private backgroundRuntimePaused = false;

  constructor(
    private readonly browserSession: BrowserSession,
    private readonly provider: ServerMangaProvider,
    private readonly byteCache: ByteCacheService | null = null,
    db?: CacheDatabase,
  ) {
    this.db = db ?? new CacheDatabase();
    this.scheduler = new DurableJobScheduler(this.db);
    this.workerId = `cache-service:${provider.id}`;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduler.recoverWorker(this.workerId);
    const staleChapterImages = this.db.deleteStaleChapterImageSchemaRows();
    if (staleChapterImages > 0) {
      console.log(`[cache] chapter-image-schema-invalidated provider=${this.provider.id} rows=${staleChapterImages} requiredSchema=2 reason=scramble-metadata`);
    }
    if (this.byteCache) {
      const version = this.db.getMeta('cover-ownership-rebuild-version');
      if (version !== COVER_OWNERSHIP_REBUILD_VERSION) {
        const rebuilt = this.db.rebuildMangaCoverOwnershipFromCachedPayloads();
        const purged = this.db.purgeUnownedByteCache();
        this.db.setMeta('cover-ownership-rebuild-version', COVER_OWNERSHIP_REBUILD_VERSION);
        console.log(`[coverCache] ownership-rebuild provider=${this.provider.id} card=${rebuilt.card} detail=${rebuilt.detail} ready=${rebuilt.ready} purgedBytes=${purged.rows}`);
      }
    }
    this.enqueueChapterUploadDateRepairs();
    if (DATA_CACHE_BACKGROUND_ENABLED) {
      this.startDailyNewestCrawl();
      this.drain();
      this.scheduleDailyRollover();
    } else {
      console.log(`[cache] background-data-cache disabled provider=${this.provider.id}; foreground requests only`);
    }
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
      providerId: this.provider.id,
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
    return this.db.getChapterList(mangaId)?.data ?? null;
  }

  isChapterListWarming(mangaId: string): boolean {
    return this.hasForegroundChapterListWork(mangaId);
  }

  getChapterImages(mangaId: string, chapterId: string, context: { chapterNumber?: number; chapterUrl?: string } = {}): unknown | null {
    const cached = this.db.getChapterImages(mangaId, chapterId);
    if (!cached) return null;
    const readiness = chapterImageReadiness(cached.data);
    if (cached.status !== 'ready' || !readiness.ready) {
      console.log(`[cache] chapter-images not-ready provider=${this.provider.id} manga=${mangaId} chapter=${chapterId} status=${cached.status} pages=${readiness.pages} targetCount=${readiness.targetCount ?? 'unknown'} source=${readiness.source} schema=${readiness.schemaVersion ?? 'unknown'} scrambleKnown=${readiness.scrambleKnown}`);
      return null;
    }
    return withImageStoreCandidates(
      cached.data,
      mangaId,
      chapterId,
      context,
      imageUrl => this.provider.imageDelivery === 'store-candidates' ? this.orderedImageStoreCandidates(imageUrl, 'preload') : [imageUrl],
      imageUrl => this.provider.imageDelivery === 'store-candidates' ? this.orderedImageStoreCandidates(imageUrl, 'critical') : [imageUrl],
    );
  }

  async decodeChapterPage(
    mangaId: string,
    chapterId: string,
    pageIndex: number,
    options: { chapterNumber?: number; chapterUrl?: string; policy?: 'critical' | 'preload' } = {},
  ): Promise<{ buffer: Buffer; contentType: 'image/png'; durationMs: number } | null> {
    const cached = this.db.getChapterImages(mangaId, chapterId);
    if (!cached) {
      this.warmChapterImages(mangaId, chapterId, options.chapterNumber, options.chapterUrl, 'decode-cache-miss', 'interactive');
      return null;
    }
    const readiness = chapterImageReadiness(cached.data);
    if (cached.status !== 'ready' || !readiness.ready) return null;

    const pages = resultPages(cached.data)
      .map(page => {
        if (!page || typeof page !== 'object') return null;
        const record = page as Record<string, unknown>;
        const url = pageImageUrl(record);
        const width = Number(record.width ?? 0);
        const height = Number(record.height ?? 0);
        return url && Number.isFinite(width) && Number.isFinite(height)
          ? { url, width, height, scramble: record.scramble === true }
          : null;
      })
      .filter((page): page is { url: string; width: number; height: number; scramble: boolean } => page != null);
    const target = pages[pageIndex];
    if (!target?.scramble) return null;

    const result = cached.data && typeof cached.data === 'object'
      ? (cached.data as Record<string, unknown>).result
      : undefined;
    const resultRecord = result && typeof result === 'object' ? result as Record<string, unknown> : {};
    const cachedNumber = typeof resultRecord.chapterNumber === 'number' && Number.isFinite(resultRecord.chapterNumber)
      ? resultRecord.chapterNumber
      : undefined;
    const cachedUrl = typeof resultRecord.chapterUrl === 'string' && resultRecord.chapterUrl.length > 0
      ? resultRecord.chapterUrl
      : undefined;

    return this.browserSession.decodeScrambledPage({
      mangaId,
      chapterId,
      chapterNumber: options.chapterNumber ?? cachedNumber,
      chapterUrl: options.chapterUrl ?? cachedUrl,
      pageIndex,
      policy: options.policy ?? 'preload',
      pages,
      imageUrlCandidates: this.orderedImageStoreCandidates(target.url, options.policy ?? 'preload'),
    });
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
      if (!manga) this.warmManga(mangaId, 'favorite-card-cache-miss', 'observed');
      snapshots.push({
        mangaId,
        manga,
        chapters,
        mangaReady: manga != null,
        chaptersReady: includeChapters ? chapters != null : false,
      });
    }
    console.log(`[cache] manga-card-snapshots provider=${this.provider.id} requested=${mangaIds.length} unique=${seen.size} includeChapters=${includeChapters} mangaReady=${snapshots.filter(item => item.mangaReady).length} chaptersReady=${snapshots.filter(item => item.chaptersReady).length}`);
    return snapshots;
  }

  refreshManga(mangaId: string, reason = 'frontend-refresh'): void {
    this.db.invalidateChapterList(mangaId);
    this.enqueue({ kind: 'cache-manga-detail', priority: 'interactive', mangaId, force: true, reason });
    this.enqueue({ kind: 'cache-chapters', priority: 'interactive', mangaId, force: true, reason });
  }

  private enqueueChapterUploadDateRepairs(): void {
    const stale = this.db.listChapterListsMissingUploadDates();
    let queued = 0;
    let existing = 0;
    for (const item of stale) {
      const status = this.enqueue({
        kind: 'cache-chapters',
        priority: 'background',
        mangaId: item.mangaId,
        force: true,
        reason: 'repair-missing-upload-dates',
      });
      if (status === 'queued' || status === 'promoted' || status === 'requeued') queued++;
      else existing++;
    }
    if (stale.length > 0) {
      const sample = stale.slice(0, 8).map(item => `${item.mangaId}:${item.missing}/${item.total}`).join(',');
      console.log(`[cache] chapter-upload-date-repair stale=${stale.length} queued=${queued} existing=${existing} sample=${sample}`);
    }
  }

  reconcileManga(mangaId: string, observedLatestChapter: number | null, priority: CacheJobPriority, source: CacheReconcileSource): CacheReconcileResult {
    const normalizedPriority = priority === 'interactive' ? 'interactive' : priority === 'foreground' ? 'foreground' : 'observed';
    const cached = this.db.getChapterList(mangaId);
    const cachedItems = cached ? resultItems(cached.data) : [];
    const { max: cachedMax } = chapterSummary(cachedItems);
    const observed = typeof observedLatestChapter === 'number' && Number.isFinite(observedLatestChapter) && observedLatestChapter > 0
      ? observedLatestChapter
      : null;

    if (!cached) {
      this.enqueue({ kind: 'cache-manga-detail', priority: normalizedPriority, mangaId, reason: `reconcile-missing-cache:${source}` });
      this.enqueue({ kind: 'cache-chapters', priority: normalizedPriority, mangaId, reason: `reconcile-missing-cache:${source}` });
      console.log(`[cache] reconcile provider=${this.provider.id} decision manga=${mangaId} source=${source} priority=${normalizedPriority} cachedMax=none observed=${observed ?? 'unknown'} action=full-refresh status=queued reason=missing-cache`);
      return { status: 'queued', mangaId, cachedMax: null, observedLatestChapter: observed, action: 'full-refresh', reason: 'missing-cache' };
    }

    if (observed == null) {
      console.log(`[cache] reconcile provider=${this.provider.id} decision manga=${mangaId} source=${source} priority=${normalizedPriority} cachedMax=${cachedMax ?? 'unknown'} observed=invalid action=none status=ignored reason=invalid-observed`);
      return { status: 'ignored', mangaId, cachedMax, observedLatestChapter: null, action: 'none', reason: 'invalid-observed' };
    }

    if (cachedMax != null && cachedMax >= observed) {
      console.log(`[cache] reconcile provider=${this.provider.id} decision manga=${mangaId} source=${source} priority=${normalizedPriority} cachedMax=${cachedMax} observed=${observed} action=none status=fresh reason=cached-up-to-date`);
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
    console.log(`[cache] reconcile provider=${this.provider.id} decision manga=${mangaId} source=${source} priority=${normalizedPriority} cachedMax=${cachedMax ?? 'unknown'} observed=${observed} action=reconcile status=${status} reason=stale-cache`);
    return { status: status === 'promoted' ? 'promoted' : 'queued', mangaId, cachedMax, observedLatestChapter: observed, action: 'reconcile', reason: 'stale-cache' };
  }

  warmManga(mangaId: string, reason = 'cache-miss', priority: CacheJobPriority = 'interactive'): void {
    this.enqueue({ kind: 'cache-manga-detail', priority, mangaId, reason });
    this.enqueue({ kind: 'cache-chapters', priority, mangaId, reason });
  }

  observeImageStore(observation: Omit<ImageStoreObservation, 'source'>): void {
    this.db.observeImageStore({ ...observation, source: 'frontend' });
    this.storeRanking = null;
    if (this.provider.imageDelivery !== 'store-candidates') {
      console.log(`[cache] image-store-observed ignored provider=${this.provider.id} reason=direct-images image=${observation.imageUrl} store=${observation.storeUrl}`);
      return;
    }
    console.log(`[cache] image-store-observed provider=${this.provider.id} ok=${observation.ok} status=${observation.status} totalMs=${observation.totalMs ?? 'unknown'} image=${observation.imageUrl} store=${observation.storeUrl}`);
  }

  refreshChapterImages(mangaId: string, chapterId: string, chapterNumber?: number, chapterUrl?: string, reason = 'frontend-refresh'): void {
    this.enqueue({ kind: 'cache-chapter-page-map', priority: 'interactive', mangaId, chapterId, chapterNumber, chapterUrl, force: true, reason });
  }

  warmChapterImages(mangaId: string, chapterId: string, chapterNumber?: number, chapterUrl?: string, reason = 'cache-miss', priority: CacheJobPriority = 'interactive'): void {
    this.enqueue({ kind: 'cache-chapter-page-map', priority, mangaId, chapterId, chapterNumber, chapterUrl, reason });
  }

  private orderedImageStoreCandidates(imageUrl: string, policy: 'critical' | 'preload'): string[] {
    const candidates = imageStoreCandidates(imageUrl);
    if (candidates.length <= 1) return candidates;
    const byHost = new Map<string, string>();
    for (const candidate of candidates) {
      const host = hostFromUrl(candidate);
      if (host && !byHost.has(host)) byHost.set(host, candidate);
    }
    if (byHost.size <= 1) return candidates;

    const ranking = this.currentStoreRanking();
    const canonicalHost = hostFromUrl(imageUrl);
    const winner = ranking.winnerHost && byHost.has(ranking.winnerHost)
      ? ranking.winnerHost
      : null;
    const canonical = canonicalHost ? byHost.get(canonicalHost) : null;
    const exploit = winner != null && Math.random() < STORE_EXPLOIT_RATE;
    const mode = canonical
      ? policy === 'critical' ? 'canonical-critical' : exploit ? 'canonical-exploit' : winner ? 'canonical-explore' : 'canonical'
      : policy === 'critical' && winner ? 'critical' : exploit ? 'exploit' : winner ? 'explore' : 'no-winner';
    const firstHost = canonicalHost && canonical
      ? canonicalHost
      : exploit
        ? winner
        : shuffled([...byHost.keys()])[0] ?? winner;
    if (!firstHost) {
      console.log(`[cache] image-store-order policy=${policy} mode=fallback canonical=${canonicalHost ?? 'none'} winner=${ranking.winnerHost ?? 'none'} first=none total=${candidates.length} image=${imageLogKey(imageUrl)}`);
      return shuffled(candidates);
    }

    const first = byHost.get(firstHost);
    if (!first) {
      console.log(`[cache] image-store-order policy=${policy} mode=fallback canonical=${canonicalHost ?? 'none'} winner=${ranking.winnerHost ?? 'none'} first=${firstHost} total=${candidates.length} image=${imageLogKey(imageUrl)}`);
      return shuffled(candidates);
    }
    const pinnedHosts = new Set<string>([firstHost]);
    const pinned = [first];
    if (canonical && canonicalHost && canonicalHost !== firstHost) {
      pinned.push(canonical);
      pinnedHosts.add(canonicalHost);
    }
    const winnerCandidate = winner && !pinnedHosts.has(winner) ? byHost.get(winner) : null;
    if (winnerCandidate && winner) {
      pinned.push(winnerCandidate);
      pinnedHosts.add(winner);
    }
    const rest = candidates.filter(candidate => {
      const host = hostFromUrl(candidate);
      return !host || !pinnedHosts.has(host);
    });
    const ordered = [...pinned, ...shuffled(rest)];
    const firstHosts = ordered
      .slice(0, 5)
      .map(candidate => hostFromUrl(candidate) ?? 'invalid')
      .join(',');
    const winnerScore = winner ? ranking.scores.find(score => score.host === winner) : null;
    console.log(`[cache] image-store-order policy=${policy} mode=${mode} canonical=${canonicalHost ?? 'none'} winner=${winner ?? 'none'} first=${firstHost} firstHosts=${firstHosts} total=${ordered.length} winnerScore=${winnerScore ? Math.round(winnerScore.score) : 'none'} winnerAttempts=${winnerScore?.attempts ?? 0} image=${imageLogKey(imageUrl)}`);
    return ordered;
  }

  private currentStoreRanking(): StoreRanking {
    const now = Date.now();
    if (this.storeRanking && this.storeRanking.expiresAt > now) return this.storeRanking;
    const observations = this.db.getImageStoreObservations(STORE_OBSERVATION_LIMIT);
    const ranking = this.computeStoreRanking(observations, now);
    this.storeRanking = { ...ranking, expiresAt: now + STORE_RANKING_TTL_MS };
    const eligibleScores = ranking.scores.filter(score => score.attempts >= STORE_MIN_EXPLOIT_SAMPLES);
    const winnerScore = ranking.winnerHost ? ranking.scores.find(score => score.host === ranking.winnerHost) : null;
    const rawBest = ranking.scores[0];
    const eligibleBest = eligibleScores[0];
    const raw = rawBest
      ? ` rawBest=${rawBest.host} rawScore=${Math.round(rawBest.score)} rawAttempts=${rawBest.attempts}`
      : ' rawBest=none';
    if (winnerScore) {
      console.log(`[cache] store-ranking winner=${winnerScore.host} eligibleBest=${winnerScore.host} score=${Math.round(winnerScore.score)} p90=${Math.round(winnerScore.p90)} p95=${Math.round(winnerScore.p95)} p98=${Math.round(winnerScore.p98)} max=${Math.round(winnerScore.max)} attempts=${winnerScore.attempts} minSamples=${STORE_MIN_EXPLOIT_SAMPLES}${raw} penalty=${Math.round(ranking.failurePenaltyMs)} observations=${observations.length}`);
    } else if (eligibleBest) {
      console.log(`[cache] store-ranking winner=none source=eligible-unselected eligibleBest=${eligibleBest.host} eligibleScore=${Math.round(eligibleBest.score)} eligibleAttempts=${eligibleBest.attempts} minSamples=${STORE_MIN_EXPLOIT_SAMPLES}${raw} penalty=${Math.round(ranking.failurePenaltyMs)} observations=${observations.length}`);
    } else if (rawBest) {
      console.log(`[cache] store-ranking winner=none source=insufficient-samples eligibleBest=none minSamples=${STORE_MIN_EXPLOIT_SAMPLES}${raw} penalty=${Math.round(ranking.failurePenaltyMs)} observations=${observations.length}`);
    } else {
      console.log(`[cache] store-ranking winner=none source=no-observations eligibleBest=none rawBest=none minSamples=${STORE_MIN_EXPLOIT_SAMPLES} penalty=${Math.round(ranking.failurePenaltyMs)}`);
    }
    return this.storeRanking;
  }

  private computeStoreRanking(observations: ImageStoreObservationRecord[], now: number): Omit<StoreRanking, 'expiresAt'> {
    const okMaxByHost = new Map<string, number>();
    for (const observation of observations) {
      if (!observation.ok || observation.status !== 200) continue;
      const current = okMaxByHost.get(observation.host) ?? 0;
      if (observation.totalMs > current) okMaxByHost.set(observation.host, observation.totalMs);
    }
    const okMaxValues = [...okMaxByHost.values()].filter(value => Number.isFinite(value) && value > 0);
    const failurePenaltyMs = okMaxValues.length > 0
      ? okMaxValues.reduce((sum, value) => sum + value, 0) / okMaxValues.length
      : STORE_FALLBACK_FAILURE_PENALTY_MS;

    const samplesByHost = new Map<string, WeightedLatencySample[]>();
    for (const observation of observations) {
      const ageMs = Math.max(0, now - observation.observedAt);
      const weight = Math.pow(0.5, ageMs / STORE_RECENCY_HALF_LIFE_MS);
      const value = observation.ok && observation.status === 200
        ? Math.max(0, observation.totalMs)
        : failurePenaltyMs;
      const samples = samplesByHost.get(observation.host) ?? [];
      samples.push({ value, weight });
      samplesByHost.set(observation.host, samples);
    }

    const scores: StoreScore[] = [];
    for (const [host, samples] of samplesByHost) {
      const p90 = weightedPercentile(samples, 0.90);
      const p95 = weightedPercentile(samples, 0.95);
      const p98 = weightedPercentile(samples, 0.98);
      const score = (p90 * STORE_TAIL_WEIGHTS.p90)
        + (p95 * STORE_TAIL_WEIGHTS.p95)
        + (p98 * STORE_TAIL_WEIGHTS.p98);
      const max = samples.reduce((largest, sample) => Math.max(largest, sample.value), 0);
      scores.push({ host, attempts: samples.length, score, p90, p95, p98, max });
    }
    scores.sort((a, b) => a.score - b.score || b.attempts - a.attempts || a.host.localeCompare(b.host));
    const eligibleScores = scores.filter(score => score.attempts >= STORE_MIN_EXPLOIT_SAMPLES);
    return {
      winnerHost: eligibleScores[0]?.host ?? null,
      failurePenaltyMs,
      scores,
    };
  }

  private enqueue(job: CacheJob): CacheJobEnqueueResult {
    if ((job.kind === 'cache-manga-detail' || job.kind === 'cache-chapters' || job.kind === 'reconcile-chapters') && job.mangaId) {
      if (this.currentJob?.kind === job.kind && this.currentJob.mangaId === job.mangaId) return 'existing';
      if (job.kind === 'reconcile-chapters') {
        const fullJob = this.scheduler.jobsForResource('cache-chapters', job.mangaId)[0];
        if (fullJob) {
          const priority = job.priority === 'interactive' ? 'interactive' : job.priority === 'foreground' ? 'foreground' : job.priority === 'observed' ? 'observed' : 'background';
          this.scheduler.updateIntent(fullJob, {
            kind: 'cache-chapters',
            resourceKey: job.mangaId,
            priority,
            payload: {
              mangaId: job.mangaId,
              force: true,
              reason: job.reason,
            },
          });
          console.log(`[cache] job-promoted kind=cache-chapters manga=${job.mangaId} from=reconcile-conflict to=${priority} force=true reason=${job.reason}`);
          this.drain();
          if (fullJob.priority < CACHE_JOB_PRIORITY[priority]) return 'promoted';
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
      requestedAt: Date.now(),
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
      retryFailedAfterMs: job.priority === 'interactive' || job.priority === 'foreground' || job.priority === 'observed'
        ? 0
        : FAILED_DATA_RETRY_MS,
    });
  }

  private nextJob() {
    const runtimeAvailable = this.browserSession.canRunBackgroundRuntimeWork();
    if (!runtimeAvailable && !this.backgroundRuntimePaused) {
      this.backgroundRuntimePaused = true;
      console.log(`[cache] runtime-background-paused provider=${this.provider.id} reason=provider-runtime-unhealthy`);
    } else if (runtimeAvailable && this.backgroundRuntimePaused) {
      this.backgroundRuntimePaused = false;
      console.log(`[cache] runtime-background-resumed provider=${this.provider.id}`);
    }
    const minPriority = DATA_CACHE_BACKGROUND_ENABLED && runtimeAvailable ? undefined : CACHE_JOB_PRIORITY.foreground;
    return this.scheduler.claimNext(this.workerId, 30 * 60 * 1000, DATA_CACHE_JOB_KINDS, minPriority);
  }

  private hasForegroundChapterListWork(mangaId: string): boolean {
    const isUserVisibleRefresh = (job: CacheJob | null | undefined) =>
      job != null
      && job.mangaId === mangaId
      && job.reason !== 'repair-missing-upload-dates'
      && (job.priority === 'interactive' || job.priority === 'foreground' || job.priority === 'observed')
      && (job.kind === 'reconcile-chapters' || (job.kind === 'cache-chapters' && job.force === true));
    if (isUserVisibleRefresh(this.currentJob)) return true;
    const chapterJobs = this.scheduler.jobsForResource('cache-chapters', mangaId);
    if (chapterJobs.some(record => isUserVisibleRefresh(this.recordToJob(record)))) return true;
    const reconcileJobs = this.scheduler.jobsForResource('reconcile-chapters', mangaId);
    return reconcileJobs.some(record => isUserVisibleRefresh(this.recordToJob(record)));
  }

  private shouldYieldToForeground(job: CacheJob): boolean {
    return this.scheduler.runnableCountAbove(job.priority) > 0;
  }

  hasHigherPriorityDataWork(): boolean {
    if (this.currentJob && CACHE_JOB_PRIORITY[this.currentJob.priority] > CACHE_JOB_PRIORITY.background) {
      return true;
    }
    return this.scheduler.runnableCountAbove('background') > 0;
  }

  private yieldToForeground(job: CacheJob, label: string): never {
    throw new CacheJobYield(`${label}: higher priority job pending`);
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
      if (this.browserSession.hasCriticalScrambledPageWork()) {
        setTimeout(() => this.drain(), 250);
        return;
      }
      const record = this.nextJob();
      if (!record) return;
      const job = this.recordToJob(record);
      this.currentJob = job;
      const start = Date.now();
      const queueAgeMs = Math.max(0, start - record.createdAt);
      const requestWaitMs = job.requestedAt ? Math.max(0, start - job.requestedAt) : 'unknown';
      const verboseLifecycle = this.shouldLogJobLifecycle(job);
      if (verboseLifecycle) {
        console.log(`[cache] job-start provider=${this.provider.id} id=${record.id} kind=${job.kind} manga=${job.mangaId ?? 'none'} priority=${job.priority} reason=${job.reason} queueAgeMs=${queueAgeMs} requestWaitMs=${requestWaitMs} attempt=${record.attempts}/${record.maxAttempts}`);
      }
      try {
        if (job.kind === 'seed-newest') await this.seedNewest(job);
        else if (job.kind === 'crawl-search-page') await this.crawlSearchPage(job);
        else if (job.kind === 'cache-manga-detail' && job.mangaId) await this.cacheMangaDetail(job.mangaId, job);
        else if (job.kind === 'cache-chapters' && job.mangaId) await this.cacheChapters(job.mangaId, job);
        else if (job.kind === 'reconcile-chapters' && job.mangaId) await this.reconcileChapters(job.mangaId, job);
        else if (job.kind === 'cache-chapter-page-map' && job.mangaId && job.chapterId) await this.cacheChapterPageMap(job.mangaId, job.chapterId, job);
        this.scheduler.complete(record);
        const runMs = Date.now() - start;
        if (verboseLifecycle || runMs >= SLOW_BACKGROUND_JOB_MS) {
          console.log(`[cache] job-done provider=${this.provider.id} id=${record.id} kind=${job.kind} manga=${job.mangaId ?? 'none'} priority=${job.priority} reason=${job.reason} queueAgeMs=${queueAgeMs} requestWaitMs=${requestWaitMs} runMs=${runMs}`);
        }
      } catch (e) {
        if (e instanceof CacheJobYield) {
          this.scheduler.yield(record, e.message);
          console.log(`[cache] job-yield provider=${this.provider.id} id=${record.id} kind=${job.kind} manga=${job.mangaId ?? 'none'} priority=${job.priority} reason=${job.reason} queueAgeMs=${queueAgeMs} requestWaitMs=${requestWaitMs} runMs=${Date.now() - start} ${e.message}`);
          continue;
        }
        const msg = conciseError((e as Error)?.message ?? String(e));
        this.scheduler.retry(record, msg, this.retryDelayMs(record.attempts));
        this.logJobFailure(job, record.id, queueAgeMs, requestWaitMs, Date.now() - start, msg);
      }
    }
  }

  private shouldLogJobLifecycle(job: CacheJob): boolean {
    return CACHE_JOB_PRIORITY[job.priority] >= VERBOSE_JOB_PRIORITY;
  }

  private logJobFailure(job: CacheJob, recordId: string, queueAgeMs: number, requestWaitMs: number | 'unknown', runMs: number, message: string): void {
    if (this.shouldLogJobLifecycle(job)) {
      console.log(`[cache] job-failed provider=${this.provider.id} id=${recordId} kind=${job.kind} manga=${job.mangaId ?? 'none'} priority=${job.priority} reason=${job.reason} queueAgeMs=${queueAgeMs} requestWaitMs=${requestWaitMs} runMs=${runMs} ${message}`);
      return;
    }

    if (job.priority !== 'background' || job.kind !== 'cache-chapter-page-map' || !job.mangaId) {
      console.log(`[cache] job-failed provider=${this.provider.id} id=${recordId} kind=${job.kind} manga=${job.mangaId ?? 'none'} priority=${job.priority} reason=${job.reason} queueAgeMs=${queueAgeMs} requestWaitMs=${requestWaitMs} runMs=${runMs} ${message}`);
      return;
    }

    const key = `${this.provider.id}:${job.kind}:${job.mangaId}:${job.reason}:${failurePattern(message)}`;
    const now = Date.now();
    let summary = this.backgroundFailures.get(key);
    if (!summary) {
      summary = {
        provider: this.provider.id,
        kind: job.kind,
        mangaId: job.mangaId,
        priority: job.priority,
        reason: job.reason,
        error: failurePattern(message),
        firstAt: now,
        lastAt: now,
        count: 0,
        runMsTotal: 0,
        sampleIds: [],
        timer: null,
      };
      this.backgroundFailures.set(key, summary);
    }
    summary.lastAt = now;
    summary.count += 1;
    summary.runMsTotal += runMs;
    if (summary.sampleIds.length < 6) summary.sampleIds.push(recordId);
    if (!summary.timer) {
      summary.timer = setTimeout(() => this.flushBackgroundFailureSummary(key), BACKGROUND_FAILURE_SUMMARY_MS);
      summary.timer.unref?.();
    }
  }

  private flushBackgroundFailureSummary(key: string): void {
    const summary = this.backgroundFailures.get(key);
    if (!summary) return;
    this.backgroundFailures.delete(key);
    const windowMs = Math.max(0, summary.lastAt - summary.firstAt);
    const avgRunMs = summary.count > 0 ? Math.round(summary.runMsTotal / summary.count) : 0;
    console.log(`[cache] job-failed-summary provider=${summary.provider} kind=${summary.kind} manga=${summary.mangaId} priority=${summary.priority} reason=${summary.reason} count=${summary.count} sampleIds=${summary.sampleIds.join(',')} avgRunMs=${avgRunMs} windowMs=${windowMs} error=${summary.error}`);
  }

  private async seedNewest(job: CacheJob): Promise<void> {
    await this.crawlSearchPage({ ...job, kind: 'crawl-search-page', page: 1 });
  }

  private startDailyNewestCrawl(): void {
    const crawlDate = todayKey();
    const demoted = this.demoteOlderSearchCrawls(crawlDate);
    if (this.db.getMeta(this.crawlSearchMetaKey(crawlDate, 'complete')) === '1') {
      console.log(`[cache] start daily-crawl provider=${this.provider.id} date=${crawlDate} action=already-complete demotedOldCrawls=${demoted}`);
      return;
    }

    const existing = this.crawlSearchJobsForDate(crawlDate);
    if (existing.length > 0) {
      console.log(`[cache] start daily-crawl provider=${this.provider.id} date=${crawlDate} action=resume-existing jobs=${existing.length} demotedOldCrawls=${demoted}`);
      this.drain();
      return;
    }

    const lastPage = Number(this.db.getMeta(this.crawlSearchMetaKey(crawlDate, 'last-page')) ?? 0);
    const page = Number.isFinite(lastPage) && lastPage > 0 ? lastPage + 1 : 1;
    this.enqueue({ kind: 'crawl-search-page', priority: 'daily', page, crawlDate, reason: 'startup' });
    console.log(`[cache] start daily-crawl provider=${this.provider.id} date=${crawlDate} action=enqueue page=${page} demotedOldCrawls=${demoted}`);
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
    const currentCrawlDate = todayKey();
    const isCurrentCrawl = crawlDate === currentCrawlDate;
    const crawlPriority: CacheJobPriority = isCurrentCrawl ? job.priority : 'background';
    if (!isCurrentCrawl && job.priority !== 'background') {
      console.log(`[cache] search-crawl stale-demoted provider=${this.provider.id} page=${page} date=${crawlDate} currentDate=${currentCrawlDate} from=${job.priority} to=background`);
    }
    const reason = job.reason;
    const url = this.provider.newestSearchUrl(page, this.provider.searchPageSize || DEFAULT_SEARCH_PAGE_SIZE);
    const start = Date.now();
    const { data, status } = await this.fetchSearchCrawlData(url, job);
    const parsed = await this.parseSearchCrawlData(data);
    const items = parsed.items;
    const pagination = parsed.pagination ?? {};
    const lastPage = Number(pagination.last_page ?? pagination.lastPage ?? pagination.lastPage ?? page);
    this.db.setMeta(`newest-page-${page}`, JSON.stringify(data));
    this.db.setMeta(this.crawlSearchMetaKey(crawlDate, 'last-page'), String(page));

    let queued = 0;
    let coverDiscovered = 0;
    let coverQueued = 0;
    for (const item of items) {
      const mangaId = mangaIdFromItem(item);
      if (!mangaId) continue;
      this.db.upsertManga(mangaId, item);
      const coverJobs = this.enqueueMangaCoverJob(mangaId, item, 'card', 'search-newest', crawlPriority);
      coverDiscovered += coverJobs.discovered;
      coverQueued += coverJobs.queued;
      this.enqueue({ kind: 'cache-manga-detail', priority: 'background', mangaId, reason });
      this.enqueue({ kind: 'cache-chapters', priority: 'background', mangaId, reason });
      queued++;
    }

    const hasNext = page < lastPage && items.length > 0;
    const otherFrontierExists = this.hasOtherCrawlSearchJob(crawlDate, page);
    if (hasNext && !otherFrontierExists) {
      this.enqueue({
        kind: 'crawl-search-page',
        priority: crawlPriority,
        page: page + 1,
        crawlDate,
        reason: `crawl-next:${crawlDate}`,
      });
    } else if (!hasNext) {
      this.db.setMeta(this.crawlSearchMetaKey(crawlDate, 'complete'), '1');
    }

    const next = hasNext
      ? otherFrontierExists ? 'existing-frontier' : page + 1
      : 'none';
    console.log(`[cache] search-crawl provider=${this.provider.id} page=${page}/${lastPage} date=${crawlDate} fetched=${items.length} queuedManga=${queued} covers=${coverDiscovered} queuedCovers=${coverQueued} next=${next} http=${status} fetchMs=${Date.now() - start}`);
  }

  private async fetchSearchCrawlData(url: string, job: CacheJob): Promise<{ data: unknown; status: number }> {
    if (this.provider.id === 'mangadotnet') {
      const result = await this.browserSession.fetchRuntimeApi(url, {
        owner: 'cache-search-crawl',
        priority: job.priority,
        reason: job.reason,
      });
      return { data: result.data, status: 200 };
    }
    const { data, meta } = await proxyFetchJson(url, { cloudflareProtected: true });
    return { data, status: meta.status };
  }

  private async parseSearchCrawlData(data: unknown): Promise<{ items: unknown[]; pagination: Record<string, unknown> }> {
    if (this.provider.id === 'comix') {
      return { items: resultItems(data), pagination: resultPagination(data) };
    }
    const provider = await getServerProvider(this.provider.id);
    const parsed = provider.parseSearchResponse(data);
    return {
      items: parsed.items,
      pagination: {
        current_page: parsed.pagination?.currentPage ?? 1,
        page: parsed.pagination?.currentPage ?? 1,
        last_page: parsed.pagination?.lastPage ?? 1,
        lastPage: parsed.pagination?.lastPage ?? 1,
        total: parsed.pagination?.total ?? parsed.items.length,
      },
    };
  }

  private crawlSearchMetaKey(crawlDate: string, suffix: string): string {
    return `crawl-search-newest:${CRAWL_SEARCH_CONTRACT_VERSION}:${crawlDate}:${suffix}`;
  }

  private async cacheMangaDetail(mangaId: string, job: CacheJob): Promise<void> {
    const existing = this.db.getManga(mangaId)?.data ?? null;
    if (!job.force && isMangaDetailPayload(existing)) {
      if (this.shouldLogJobLifecycle(job)) {
        console.log(`[cache] manga-detail provider=${this.provider.id} skip manga=${mangaId} reason=cached`);
      }
      return;
    }

    const result = await this.browserSession.fetchMangaDetail(mangaId, {
      owner: 'cache-manga-detail',
      priority: job.priority,
      reason: job.reason,
    });
    this.db.upsertManga(mangaId, result.data);
    const detail = result.data && typeof result.data === 'object'
      ? (result.data as Record<string, unknown>).result
      : undefined;
    const r = detail && typeof detail === 'object' ? detail as Record<string, unknown> : {};
    const recommendations = Array.isArray(r.recommendations) ? r.recommendations.length : 0;
    const tags = Array.isArray(r.tags) ? r.tags.length : 0;
    const genres = Array.isArray(r.genres) ? r.genres.length : 0;
    const description = Boolean(r.synopsis || r.description);
    const coverJobs = this.enqueueMangaCoverJob(mangaId, r, 'detail', 'manga-detail', job.priority);
    if (this.shouldLogJobLifecycle(job)) {
      console.log(`[cache] manga-detail provider=${this.provider.id} cached manga=${mangaId} recommendations=${recommendations} genres=${genres} tags=${tags} description=${description} cover=${coverJobs.queued}/${coverJobs.discovered} fetchMs=${result.durationMs}`);
    }
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
      if (this.shouldLogJobLifecycle(job)) {
        console.log(`[cache] chapters provider=${this.provider.id} skip manga=${mangaId} reason=cached`);
      }
      return;
    }

    const first = await this.fetchChapterPage(mangaId, 1, job);
    const pagination = resultPagination(first);
    const lastPage = Number(pagination.last_page ?? pagination.lastPage ?? 1);
    const allItems = [...resultItems(first)];
    let failed = 0;

    for (let page = 2; page <= lastPage; page++) {
      if (this.shouldYieldToForeground(job)) {
        this.yieldToForeground(job, `cache-chapters manga=${mangaId} beforePage=${page}/${lastPage}`);
      }
      if (this.scheduler.runnableCountAbove('background') > 0 && job.priority === 'background') {
        this.enqueue({ kind: 'cache-chapters', priority: 'background', mangaId, reason: 'resume-after-foreground' });
        console.log(`[cache] chapters provider=${this.provider.id} yield manga=${mangaId} higherPriorityJobs=${this.scheduler.runnableCountAbove('background')}`);
        return;
      }
      try {
        const data = await this.fetchChapterPage(mangaId, page, job);
        allItems.push(...resultItems(data));
      } catch (e) {
        failed++;
        const msg = (e as Error)?.message ?? String(e);
        console.log(`[cache] chapters provider=${this.provider.id} page-failed manga=${mangaId} page=${page}/${lastPage} ${msg}`);
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
    this.db.upsertChapterList(mangaId, staticChapterListPayload(cached), failed > 0 ? 'partial' : 'ready');
    const pageMapJobs = this.enqueueChapterPageMapJobs(mangaId, allItems, 'chapter-list-cached');
    if (this.shouldLogJobLifecycle(job) || failed > 0) {
      console.log(`[cache] chapters provider=${this.provider.id} cached manga=${mangaId} pages=${lastPage} items=${allItems.length} failed=${failed} pageMapJobs=${pageMapJobs.queued}/${pageMapJobs.discovered}`);
    }
  }

  private async reconcileChapters(mangaId: string, job: CacheJob): Promise<void> {
    const cached = this.db.getChapterList(mangaId);
    if (!cached) {
      console.log(`[cache] reconcile provider=${this.provider.id} missing-cache manga=${mangaId} priority=${job.priority} source=${job.source ?? 'unknown'} action=full-refresh`);
      this.enqueue({ kind: 'cache-chapters', priority: job.priority, mangaId, force: true, reason: 'reconcile-missing-cache' });
      return;
    }

    const cachedItems = resultItems(cached.data);
    const cachedIds = new Set(cachedItems.map(chapterIdFromItem).filter((id): id is string => id != null));
    const { max: previousMax } = chapterSummary(cachedItems);
    const observed = job.observedLatestChapter;
    if (observed != null && previousMax != null && previousMax >= observed) {
      console.log(`[cache] reconcile provider=${this.provider.id} fresh-at-run manga=${mangaId} cachedMax=${previousMax} observed=${observed} priority=${job.priority}`);
      return;
    }

    const newItems: unknown[] = [];
    let reachedExisting = false;
    let fetchedPages = 0;
    let lastPagination: Record<string, unknown> = resultPagination(cached.data);

    for (let page = 1; page <= RECONCILE_PAGE_BUDGET; page++) {
      if (this.shouldYieldToForeground(job)) {
        this.yieldToForeground(job, `reconcile-chapters manga=${mangaId} beforePage=${page}/${RECONCILE_PAGE_BUDGET}`);
      }
      const data = await this.fetchChapterPage(mangaId, page, job);
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
      console.log(`[cache] reconcile provider=${this.provider.id} page manga=${mangaId} page=${page} items=${items.length} new=${pageNew} reachedExisting=${reachedExisting} cachedMax=${previousMax ?? 'unknown'} observed=${observed ?? 'unknown'}`);
      if (reachedExisting) break;
    }

    if (!reachedExisting && fetchedPages >= RECONCILE_PAGE_BUDGET) {
      this.enqueue({ kind: 'cache-chapters', priority: job.priority, mangaId, force: true, reason: 'reconcile-budget-exceeded' });
      console.log(`[cache] reconcile provider=${this.provider.id} fallback manga=${mangaId} pages=${fetchedPages} new=${newItems.length} action=full-refresh reason=budget-exceeded`);
      return;
    }

    if (newItems.length === 0) {
      console.log(`[cache] reconcile provider=${this.provider.id} no-new-items manga=${mangaId} cachedMax=${previousMax ?? 'unknown'} observed=${observed ?? 'unknown'} pages=${fetchedPages}`);
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

    this.db.upsertChapterList(mangaId, staticChapterListPayload(merged), cached.status === 'partial' ? 'partial' : 'ready');
    const pageMapJobs = this.enqueueChapterPageMapJobs(mangaId, newItems, 'chapter-reconcile-new');
    console.log(`[cache] reconcile provider=${this.provider.id} merged manga=${mangaId} previousCount=${cachedItems.length} nextCount=${mergedItems.length} previousMax=${previousMax ?? 'unknown'} nextMax=${nextMax ?? 'unknown'} new=${newItems.length} pages=${fetchedPages} pageMapJobs=${pageMapJobs.queued}/${pageMapJobs.discovered}`);
  }

  private async fetchChapterPage(mangaId: string, page: number, job: CacheJob): Promise<unknown> {
    const result = await this.browserSession.fetchChapterListPage(mangaId, page, CHAPTER_PAGE_SIZE, {
      owner: job.kind,
      priority: job.priority,
      reason: job.reason,
    });
    return result.data;
  }

  private enqueueMangaCoverJob(mangaId: string, data: unknown, variant: 'card' | 'detail', reason: string, priority: CacheJobPriorityName): { discovered: number; queued: number } {
    const url = coverUrlFromItem(data, variant);
    if (!url || !this.byteCache) return { discovered: 0, queued: 0 };
    const status = this.byteCache.warmCover(mangaId, variant, url, this.provider.searchThumbnailReferer(), priority, reason);
    return { discovered: 1, queued: status === 'queued' || status === 'promoted' || status === 'requeued' ? 1 : 0 };
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
      const chapterUrl = this.provider.rawMangaUrlFromChapterItem(chapter, mangaId, chapterId, chapterNumber);
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
      if (this.shouldLogJobLifecycle(job)) {
        console.log(`[cache] chapter-page-map provider=${this.provider.id} skip manga=${mangaId} chapter=${chapterId} priority=${job.priority} reason=${job.reason} status=cached`);
      }
      return;
    }

    const start = Date.now();
    const result = await this.browserSession.fetchChapterImages(mangaId, chapterId, job.chapterNumber, job.chapterUrl, {
      owner: 'cache-chapter-page-map',
      priority: job.priority,
      reason: job.reason,
    });
    const pages = resultPages(result.data);
    const readiness = chapterImageReadiness(result.data);
    const scrambled = pages.filter(page => page && typeof page === 'object' && (page as Record<string, unknown>).scramble === true).length;
    if (scrambled > 0) this.browserSession.warmScrambledPageDecoder(mangaId);
    for (const page of pages) {
      const imageUrl = pageImageUrl(page);
      if (imageUrl) learnStoreHostFromUrl(imageUrl);
    }
    this.db.upsertChapterImages(mangaId, chapterId, result.data, readiness.ready ? 'ready' : 'empty');
    if (this.shouldLogJobLifecycle(job) || !readiness.ready) {
      console.log(`[cache] chapter-page-map provider=${this.provider.id} cached manga=${mangaId} chapter=${chapterId} priority=${job.priority} reason=${job.reason} status=${readiness.ready ? 'ready' : 'empty'} pages=${pages.length} targetCount=${readiness.targetCount ?? 'unknown'} source=${readiness.source} schema=${readiness.schemaVersion ?? 'unknown'} scrambleKnown=${readiness.scrambleKnown} scrambled=${scrambled} fetchMs=${result.durationMs} totalMs=${Date.now() - start}`);
    }
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
    return priority === 'interactive' ? 'interactive' : priority === 'foreground' ? 'foreground' : priority === 'observed' ? 'observed' : priority === 'daily' ? 'daily' : 'background';
  }

  private recordToJob(record: { kind: string; payload: unknown }): CacheJob {
    const payload = payloadObject(record.payload);
    return {
      kind: record.kind as CacheJobKind,
      priority: payload.priority === 'interactive' || payload.priority === 'foreground' || payload.priority === 'observed' || payload.priority === 'daily' ? payload.priority : 'background',
      requestedAt: numberOrUndefined(payload.requestedAt),
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

function failurePattern(error: string): string {
  return conciseError(error)
    .replace(/for [^/\s]+\/[^:\s]+:/, 'for <manga>/<chapter>:')
    .replace(/\btargetCount=\d+\b/g, 'targetCount=*')
    .replace(/\bpages=\d+\b/g, 'pages=*');
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
