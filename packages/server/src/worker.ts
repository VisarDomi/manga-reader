import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createApp } from './app.js';
import { WORKER_SOCKET_PATH } from './config.js';
import { ProviderCoordinator } from './services/ProviderCoordinator.js';
import { startWorkerStatusSnapshotWriter } from './services/WorkerStatusSnapshot.js';

const coordinator = new ProviderCoordinator({ role: 'worker' });
const app = createApp(coordinator);
const server = http.createServer(app);
let stopStatusSnapshotWriter: (() => void) | null = null;

fs.mkdirSync(path.dirname(WORKER_SOCKET_PATH), { recursive: true });
try {
  fs.unlinkSync(WORKER_SOCKET_PATH);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

server.listen(WORKER_SOCKET_PATH, () => {
  fs.chmodSync(WORKER_SOCKET_PATH, 0o600);
  console.log(`[worker] manga-worker listening socket=${WORKER_SOCKET_PATH}`);
  stopStatusSnapshotWriter = startWorkerStatusSnapshotWriter(coordinator);
  void coordinator.start();
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[worker] ${signal} received - shutting down`);
  stopStatusSnapshotWriter?.();
  stopStatusSnapshotWriter = null;
  await coordinator.destroy().catch((error) => {
    console.error(`[worker] shutdown-error ${String((error as Error)?.message ?? error)}`);
  });
  server.close(() => {
    try {
      fs.unlinkSync(WORKER_SOCKET_PATH);
    } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
