import type { BrowserSession } from '../services/BrowserSession.js';
import { learnStoreHostFromUrl, listStoreHosts } from '../utils/storeHosts.js';
import { proxyFetchJson } from '../utils/proxyFetch.js';
import { DATA_CACHE_BACKGROUND_ENABLED } from '../config.js';
import { CacheDatabase, type CacheJobEnqueueResult, type ImageStoreObservation, type ImageStoreObservationRecord } from './sqlite.js';
import { CACHE_JOB_PRIORITY, DurableJobScheduler, type CacheJobPriorityName } from './DurableJobScheduler.js';
import type { ByteCacheService } from './ByteCacheService.js';
import type { ServerMangaProvider } from '../providers/types.js';

const NEWEST_LIMIT = 100;
const CHAPTER_PAGE_SIZE = 100;
const RECONCILE_PAGE_BUDGET = 5;
const CACHE_WORKER_ID = 'cache-service';
const DATA_CACHE_JOB_KINDS = ['seed-newest', 'crawl-search-page', 'cache-manga-detail', 'cache-chapters', 'reconcile-chapters', 'cache-chapter-page-map'];
const CACHE_DAY_ROLLOVER_HOUR = 4;
const CACHE_DAY_ROLLOVER_MINUTE = 45;
const FAILED_DATA_RETRY_MS = 6 * 60 * 60 * 1000;
const COVER_OWNERSHIP_REBUILD_VERSION = '1';
const STORE_OBSERVATION_LIMIT = 50_000;
const STORE_RANKING_TTL_MS = 30_000;
const STORE_RECENCY_HALF_LIFE_MS = 24 * 60 * 60 * 1000;
const STORE_EXPLOIT_RATE = 0.8;
const STORE_MIN_EXPLOIT_SAMPLES = 50;
const STORE_FALLBACK_FAILURE_PENALTY_MS = 12_000;
const STORE_TAIL_WEIGHTS = {
  p90: 0.25,
  p95: 0.4,
  p98: 0.35,
};

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
  const match = /^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|mo|mos|month|months|y|yr|yrs|year|years)$/.exec(text);
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
  const ready = source === 'runtime-http'
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

function withImageStoreCandidates(data: unknown, candidateOrder: (imageUrl: string) => string[]): unknown {
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
      pages: resultRecord.pages.map(page => {
        const imageUrl = pageImageUrl(page);
        if (!imageUrl || !page || typeof page !== 'object') return page;
        return {
          ...(page as Record<string, unknown>),
          candidates: candidateOrder(imageUrl),
        };
      }),
    },
  };
}

function coverUrlFromItem(data: unknown, variant: 'card' | 'detail'): string | null {
  if (!data || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  const poster = raw.poster && typeof raw.poster === 'object'
    ? raw.poster as Record<string, unknown>
    : {};
  const preferred = variant === 'detail'
    ? poster.large ?? poster.medium ?? poster.small
    : poster.medium ?? poster.large ?? poster.small;
  return typeof preferred === 'string' && preferred.length > 0 ? preferred : null;
}

export class CacheService {
  private readonly db = new CacheDatabase();
  private readonly scheduler = new DurableJobScheduler(this.db);
  private active = false;
  private started = false;
  private currentJob: CacheJob | null = null;
  private dailyRolloverTimer: ReturnType<typeof setTimeout> | null = null;
  private storeRanking: StoreRanking | null = null;

  constructor(
    private readonly browserSession: BrowserSession,
    private readonly provider: ServerMangaProvider,
    private readonly byteCache: ByteCacheService | null = null,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduler.recoverWorker(CACHE_WORKER_ID);
    if (this.byteCache) {
      const version = this.db.getMeta('cover-ownership-rebuild-version');
      if (version !== COVER_OWNERSHIP_REBUILD_VERSION) {
        const rebuilt = this.db.rebuildMangaCoverOwnershipFromCachedPayloads();
        const purged = this.db.purgeUnownedByteCache();
        this.db.setMeta('cover-ownership-rebuild-version', COVER_OWNERSHIP_REBUILD_VERSION);
        console.log(`[coverCache] ownership-rebuild card=${rebuilt.card} detail=${rebuilt.detail} ready=${rebuilt.ready} purgedBytes=${purged.rows}`);
      }
    }
    if (DATA_CACHE_BACKGROUND_ENABLED) {
      this.startDailyNewestCrawl();
      this.drain();
      this.scheduleDailyRollover();
    } else {
      console.log('[cache] background-data-cache disabled; foreground requests only');
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
    return withImageStoreCandidates(cached.data, imageUrl => this.orderedImageStoreCandidates(imageUrl));
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
    console.log(`[cache] manga-card-snapshots requested=${mangaIds.length} unique=${seen.size} includeChapters=${includeChapters} mangaReady=${snapshots.filter(item => item.mangaReady).length} chaptersReady=${snapshots.filter(item => item.chaptersReady).length}`);
    return snapshots;
  }

  refreshManga(mangaId: string, reason = 'frontend-refresh'): void {
    this.db.invalidateChapterList(mangaId);
    this.enqueue({ kind: 'cache-manga-detail', priority: 'interactive', mangaId, force: true, reason });
    this.enqueue({ kind: 'cache-chapters', priority: 'interactive', mangaId, force: true, reason });
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

  warmManga(mangaId: string, reason = 'cache-miss', priority: CacheJobPriority = 'interactive'): void {
    this.enqueue({ kind: 'cache-manga-detail', priority, mangaId, reason });
    this.enqueue({ kind: 'cache-chapters', priority, mangaId, reason });
  }

  observeImageStore(observation: Omit<ImageStoreObservation, 'source'>): void {
    this.db.observeImageStore({ ...observation, source: 'frontend' });
    this.storeRanking = null;
    console.log(`[cache] image-store-observed ok=${observation.ok} status=${observation.status} totalMs=${observation.totalMs ?? 'unknown'} image=${observation.imageUrl} store=${observation.storeUrl}`);
  }

  refreshChapterImages(mangaId: string, chapterId: string, chapterNumber?: number, chapterUrl?: string, reason = 'frontend-refresh'): void {
    this.enqueue({ kind: 'cache-chapter-page-map', priority: 'interactive', mangaId, chapterId, chapterNumber, chapterUrl, force: true, reason });
  }

  warmChapterImages(mangaId: string, chapterId: string, chapterNumber?: number, chapterUrl?: string, reason = 'cache-miss', priority: CacheJobPriority = 'interactive'): void {
    this.enqueue({ kind: 'cache-chapter-page-map', priority, mangaId, chapterId, chapterNumber, chapterUrl, reason });
  }

  private orderedImageStoreCandidates(imageUrl: string): string[] {
    const candidates = imageStoreCandidates(imageUrl);
    if (candidates.length <= 1) return candidates;
    const byHost = new Map<string, string>();
    for (const candidate of candidates) {
      const host = hostFromUrl(candidate);
      if (host && !byHost.has(host)) byHost.set(host, candidate);
    }
    if (byHost.size <= 1) return candidates;

    const ranking = this.currentStoreRanking();
    const winner = ranking.winnerHost && byHost.has(ranking.winnerHost)
      ? ranking.winnerHost
      : null;
    const exploit = winner != null && Math.random() < STORE_EXPLOIT_RATE;
    const firstHost = exploit
      ? winner
      : shuffled([...byHost.keys()])[0] ?? winner;
    if (!firstHost) return shuffled(candidates);

    const first = byHost.get(firstHost);
    if (!first) return shuffled(candidates);
    const rest = candidates.filter(candidate => hostFromUrl(candidate) !== firstHost);
    return [first, ...shuffled(rest)];
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
    const minPriority = DATA_CACHE_BACKGROUND_ENABLED ? undefined : CACHE_JOB_PRIORITY.foreground;
    return this.scheduler.claimNext(CACHE_WORKER_ID, 30 * 60 * 1000, DATA_CACHE_JOB_KINDS, minPriority);
  }

  private hasChapterRepairWork(mangaId: string): boolean {
    const isRepair = (job: CacheJob | null | undefined) =>
      job != null
      && job.mangaId === mangaId
      && (job.kind === 'reconcile-chapters' || (job.kind === 'cache-chapters' && job.force === true));
    if (isRepair(this.currentJob)) return true;
    const chapterJobs = this.scheduler.jobsForResource('cache-chapters', mangaId);
    if (chapterJobs.some(record => isRepair(this.recordToJob(record)))) return true;
    const reconcileJobs = this.scheduler.jobsForResource('reconcile-chapters', mangaId);
    return reconcileJobs.some(record => isRepair(this.recordToJob(record)));
  }

  private shouldYieldToForeground(job: CacheJob): boolean {
    return this.scheduler.runnableCountAbove(job.priority) > 0;
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
        if (e instanceof CacheJobYield) {
          this.scheduler.yield(record, e.message);
          console.log(`[cache] job-yield kind=${job.kind} manga=${job.mangaId ?? 'none'} reason=${job.reason} ${Date.now() - start}ms ${e.message}`);
          continue;
        }
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
    const url = this.provider.newestSearchUrl(page, NEWEST_LIMIT);
    const start = Date.now();
    const { data, meta } = await proxyFetchJson(url, { cloudflareProtected: true });
    const items = resultItems(data);
    const pagination = resultPagination(data);
    const lastPage = Number(pagination.last_page ?? pagination.lastPage ?? page);
    this.db.setMeta(`newest-page-${page}`, JSON.stringify(data));
    this.db.setMeta(`crawl-search-newest:${crawlDate}:last-page`, String(page));

    let queued = 0;
    let coverDiscovered = 0;
    let coverQueued = 0;
    for (const item of items) {
      const mangaId = mangaIdFromItem(item);
      if (!mangaId) continue;
      this.db.upsertManga(mangaId, item);
      const coverJobs = this.enqueueMangaCoverJob(mangaId, item, 'card', 'search-newest', 'daily');
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
    console.log(`[cache] search-crawl page=${page}/${lastPage} date=${crawlDate} fetched=${items.length} queuedManga=${queued} covers=${coverDiscovered} queuedCovers=${coverQueued} next=${next} http=${meta.status} fetchMs=${Date.now() - start}`);
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
    const coverJobs = this.enqueueMangaCoverJob(mangaId, r, 'detail', 'manga-detail', job.priority);
    console.log(`[cache] manga-detail cached manga=${mangaId} recommendations=${recommendations} genres=${genres} tags=${tags} description=${description} cover=${coverJobs.queued}/${coverJobs.discovered} fetchMs=${result.durationMs}`);
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
      if (this.shouldYieldToForeground(job)) {
        this.yieldToForeground(job, `cache-chapters manga=${mangaId} beforePage=${page}/${lastPage}`);
      }
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
    this.db.upsertChapterList(mangaId, staticChapterListPayload(cached), failed > 0 ? 'partial' : 'ready');
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
      if (this.shouldYieldToForeground(job)) {
        this.yieldToForeground(job, `reconcile-chapters manga=${mangaId} beforePage=${page}/${RECONCILE_PAGE_BUDGET}`);
      }
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

    this.db.upsertChapterList(mangaId, staticChapterListPayload(merged), cached.status === 'partial' ? 'partial' : 'ready');
    const pageMapJobs = this.enqueueChapterPageMapJobs(mangaId, newItems, 'chapter-reconcile-new');
    console.log(`[cache] reconcile merged manga=${mangaId} previousCount=${cachedItems.length} nextCount=${mergedItems.length} previousMax=${previousMax ?? 'unknown'} nextMax=${nextMax ?? 'unknown'} new=${newItems.length} pages=${fetchedPages} pageMapJobs=${pageMapJobs.queued}/${pageMapJobs.discovered}`);
  }

  private async fetchChapterPage(mangaId: string, page: number): Promise<unknown> {
    const result = await this.browserSession.fetchChapterListPage(mangaId, page, CHAPTER_PAGE_SIZE);
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
      console.log(`[cache] chapter-page-map skip manga=${mangaId} chapter=${chapterId} reason=cached`);
      return;
    }

    const start = Date.now();
    const result = await this.browserSession.fetchChapterImages(mangaId, chapterId);
    const pages = resultPages(result.data);
    const readiness = chapterImageReadiness(result.data);
    for (const page of pages) {
      const imageUrl = pageImageUrl(page);
      if (imageUrl) learnStoreHostFromUrl(imageUrl);
    }
    this.db.upsertChapterImages(mangaId, chapterId, result.data, readiness.ready ? 'ready' : 'empty');
    console.log(`[cache] chapter-page-map cached manga=${mangaId} chapter=${chapterId} status=${readiness.ready ? 'ready' : 'empty'} pages=${pages.length} targetCount=${readiness.targetCount ?? 'unknown'} source=${readiness.source} fetchMs=${result.durationMs} totalMs=${Date.now() - start}`);
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
