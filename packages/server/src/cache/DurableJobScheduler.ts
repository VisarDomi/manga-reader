import { CacheDatabase, type CacheJobEnqueueResult, type CacheJobRecord } from './sqlite.js';

export const CACHE_JOB_PRIORITY = {
  interactive: 2000,
  foreground: 1000,
  observed: 500,
  daily: 100,
  background: 10,
} as const;

export type CacheJobPriorityName = keyof typeof CACHE_JOB_PRIORITY;

export interface DurableJobInput {
  kind: string;
  resourceKey: string;
  priority: CacheJobPriorityName;
  payload?: unknown;
  runAfter?: number;
  maxAttempts?: number;
  retryFailedAfterMs?: number;
}

const BULK_JOB_KINDS = new Set(['cache-byte', 'crawl-search-page', 'cache-manga-detail', 'cache-chapters', 'cache-chapter-page-map']);

export class DurableJobScheduler {
  constructor(private readonly db: CacheDatabase) {}

  enqueueUnique(input: DurableJobInput): CacheJobEnqueueResult {
    const status = this.db.enqueueJob({
      kind: input.kind,
      resourceKey: input.resourceKey,
      priority: CACHE_JOB_PRIORITY[input.priority],
      payload: {
        ...(input.payload && typeof input.payload === 'object' ? input.payload as Record<string, unknown> : {}),
        priority: input.priority,
      },
      runAfter: input.runAfter,
      maxAttempts: input.maxAttempts,
      retryFailedAfterMs: input.retryFailedAfterMs,
    });
    if (this.shouldLogLifecycle(input.kind, input.priority, status)) {
      console.log(`[cache-scheduler] enqueue kind=${input.kind} resource=${input.resourceKey} priority=${input.priority} status=${status}`);
    }
    return status;
  }

  promote(input: DurableJobInput): CacheJobEnqueueResult {
    return this.enqueueUnique(input);
  }

  claimNext(workerId: string, leaseMs: number, kinds?: string[], minPriority?: number, maxPriority?: number): CacheJobRecord | null {
    const job = this.db.claimNextJob(workerId, leaseMs, Date.now(), kinds, minPriority, maxPriority);
    if (job && this.shouldLogRecord(job.kind, job.priority)) {
      console.log(`[cache-scheduler] claim id=${job.id} kind=${job.kind} resource=${job.resourceKey} priority=${job.priority} attempt=${job.attempts}/${job.maxAttempts}`);
    }
    return job;
  }

  complete(job: CacheJobRecord): void {
    this.db.completeJob(job.id);
    if (this.shouldLogRecord(job.kind, job.priority)) {
      console.log(`[cache-scheduler] complete id=${job.id} kind=${job.kind} resource=${job.resourceKey}`);
    }
  }

  updatePriority(job: CacheJobRecord, priority: CacheJobPriorityName): void {
    this.db.updateJobPriority(job.id, CACHE_JOB_PRIORITY[priority]);
  }

  updateIntent(job: CacheJobRecord, input: DurableJobInput): void {
    this.db.updateJobIntent(job.id, CACHE_JOB_PRIORITY[input.priority], {
      ...(input.payload && typeof input.payload === 'object' ? input.payload as Record<string, unknown> : {}),
      priority: input.priority,
    }, input.runAfter);
  }

  retry(job: CacheJobRecord, error: string, delayMs: number): void {
    const runAfter = Date.now() + delayMs;
    const message = conciseError(error);
    this.db.retryJob(job.id, message, runAfter);
    if (this.shouldLogRecord(job.kind, job.priority)) {
      console.log(`[cache-scheduler] retry id=${job.id} kind=${job.kind} resource=${job.resourceKey} delayMs=${delayMs} error=${message}`);
    }
  }

  yield(job: CacheJobRecord, reason: string): void {
    const message = conciseError(reason);
    this.db.yieldJob(job.id, message);
    console.log(`[cache-scheduler] yield id=${job.id} kind=${job.kind} resource=${job.resourceKey} reason=${message}`);
  }

  fail(job: CacheJobRecord, error: string): void {
    const message = conciseError(error);
    this.db.failJob(job.id, message);
    console.log(`[cache-scheduler] fail id=${job.id} kind=${job.kind} resource=${job.resourceKey} error=${message}`);
  }

  recoverWorker(workerId: string): number {
    const recovered = this.db.recoverRunningJobsForOwner(workerId);
    if (recovered > 0) console.log(`[cache-scheduler] recovered-running worker=${workerId} jobs=${recovered}`);
    return recovered;
  }

  recoverExpiredRunning(limit = 100): number {
    const now = Date.now();
    const recovered = this.db.recoverExpiredRunningJobs(now, limit);
    if (recovered.length > 0) {
      const sample = recovered.slice(0, 5)
        .map(job => `${job.kind}:${job.resourceKey}:owner=${job.leaseOwner ?? 'none'}`)
        .join(',');
      const oldestLeaseUntil = recovered.reduce<number | null>((oldest, job) => {
        if (job.leaseUntil == null) return oldest;
        return oldest == null ? job.leaseUntil : Math.min(oldest, job.leaseUntil);
      }, null);
      const oldestAgeMs = oldestLeaseUntil == null ? 'unknown' : String(Math.max(0, now - oldestLeaseUntil));
      console.log(`[cache-scheduler] reaper-recovered-expired jobs=${recovered.length} oldestAgeMs=${oldestAgeMs} sample=${sample}`);
    }
    return recovered.length;
  }

  counts(): Record<string, number> {
    return this.db.cacheJobCounts();
  }

  runnableCountAbove(priority: CacheJobPriorityName): number {
    return this.db.getRunnableJobCountAbove(CACHE_JOB_PRIORITY[priority]);
  }

  jobsForResource(kind: string, resourceKey: string): CacheJobRecord[] {
    return this.db.getJobsForResource(kind, resourceKey);
  }

  jobsByKinds(kinds: string[]): CacheJobRecord[] {
    return this.db.getJobsByKinds(kinds);
  }

  private shouldLogLifecycle(kind: string, priority: CacheJobPriorityName, status: CacheJobEnqueueResult): boolean {
    if (status === 'requeued') return true;
    if (priority === 'interactive' || priority === 'foreground') return true;
    if (status === 'promoted') return !BULK_JOB_KINDS.has(kind);
    if (status === 'existing') return false;
    return !BULK_JOB_KINDS.has(kind);
  }

  private shouldLogRecord(kind: string, priority: number): boolean {
    if (priority >= CACHE_JOB_PRIORITY.foreground) return true;
    return !BULK_JOB_KINDS.has(kind);
  }
}

function conciseError(error: string): string {
  return error.split('\n')[0]?.trim().slice(0, 500) || 'unknown-error';
}
