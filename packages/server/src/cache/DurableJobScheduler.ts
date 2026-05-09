import { CacheDatabase, type CacheJobEnqueueResult, type CacheJobRecord } from './sqlite.js';

export const CACHE_JOB_PRIORITY = {
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
}

const BULK_JOB_KINDS = new Set(['cache-byte', 'cache-manga-detail', 'cache-chapters', 'cache-chapter-page-map']);

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
    });
    if (this.shouldLogLifecycle(input.kind, input.priority, status)) {
      console.log(`[cache-scheduler] enqueue kind=${input.kind} resource=${input.resourceKey} priority=${input.priority} status=${status}`);
    }
    return status;
  }

  promote(input: DurableJobInput): CacheJobEnqueueResult {
    return this.enqueueUnique(input);
  }

  claimNext(workerId: string, leaseMs: number, kinds?: string[]): CacheJobRecord | null {
    const job = this.db.claimNextJob(workerId, leaseMs, Date.now(), kinds);
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

  retry(job: CacheJobRecord, error: string, delayMs: number): void {
    const runAfter = Date.now() + delayMs;
    const message = conciseError(error);
    this.db.retryJob(job.id, message, runAfter);
    console.log(`[cache-scheduler] retry id=${job.id} kind=${job.kind} resource=${job.resourceKey} delayMs=${delayMs} error=${message}`);
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
    if (priority === 'foreground' || priority === 'observed' || status === 'promoted') return true;
    if (status === 'existing') return false;
    return !BULK_JOB_KINDS.has(kind);
  }

  private shouldLogRecord(kind: string, priority: number): boolean {
    if (priority >= CACHE_JOB_PRIORITY.observed) return true;
    return !BULK_JOB_KINDS.has(kind);
  }
}

function conciseError(error: string): string {
  return error.split('\n')[0]?.trim().slice(0, 500) || 'unknown-error';
}
