import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from '../config.js';
import type { ProviderCoordinator } from './ProviderCoordinator.js';

export interface WorkerStatusSnapshot {
  version: 1;
  updatedAt: number;
  providers: ReturnType<ProviderCoordinator['list']>;
  cache: Record<string, Record<string, unknown>>;
}

const SNAPSHOT_PATH = path.join(STATE_DIR, 'worker-status.json');

export function readWorkerStatusSnapshot(): WorkerStatusSnapshot | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8')) as WorkerStatusSnapshot;
    if (parsed?.version !== 1 || typeof parsed.updatedAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeWorkerStatusSnapshot(coordinator: ProviderCoordinator): void {
  const providers = coordinator.list();
  const cache: Record<string, Record<string, unknown>> = {};
  for (const provider of providers) {
    const owner = coordinator.get(provider.id);
    cache[provider.id] = owner?.cache.status() ?? {
      started: false,
      providerId: provider.id,
      active: false,
      activeLanes: [],
      currentJobs: {},
    };
  }

  const snapshot: WorkerStatusSnapshot = {
    version: 1,
    updatedAt: Date.now(),
    providers,
    cache,
  };
  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  const tempPath = `${SNAPSHOT_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(snapshot));
  fs.renameSync(tempPath, SNAPSHOT_PATH);
}

export function startWorkerStatusSnapshotWriter(coordinator: ProviderCoordinator): () => void {
  const write = () => {
    try {
      writeWorkerStatusSnapshot(coordinator);
    } catch (error) {
      console.log(`[workerStatus] snapshot-write-failed error=${String((error as Error)?.message ?? error)}`);
    }
  };
  write();
  const timer = setInterval(write, 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}
