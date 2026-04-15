import { proxyFetchText } from './proxyFetch.js';

const PREWARM_URL = 'https://comix.to';
const INTERVAL_MS = 5_000;

type Status = 'unknown' | 'ok' | 'blocked';

class PrewarmMonitor {
  private status: Status = 'unknown';
  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.timer) return;
    console.log(`[prewarm] Keeping comix.to warm every ${INTERVAL_MS / 1000}s`);
    this.tick();
    this.timer = setInterval(() => this.tick(), INTERVAL_MS);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    let next: Status;
    try {
      await proxyFetchText(PREWARM_URL, { method: 'HEAD', cloudflareProtected: true });
      next = 'ok';
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (this.status !== 'blocked') {
        console.error(`[prewarm] tick failed: ${msg}`);
      }
      next = 'blocked';
    }

    if (next !== this.status) {
      console.log(`[prewarm] comix.to ${next === 'ok' ? 'OK' : 'BLOCKED'}`);
      this.status = next;
    }
  }
}

const monitor = new PrewarmMonitor();

export function startPrewarm(): void {
  monitor.start();
}
