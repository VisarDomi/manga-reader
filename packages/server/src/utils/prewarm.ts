import { proxyFetch } from './proxyFetch';

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
      const r = await proxyFetch(PREWARM_URL, { method: 'HEAD', cloudflareProtected: true });
      await r.text();
      next = 'ok';
    } catch {
      // proxyFetch triggers CF solve on block — we just track the transition
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
