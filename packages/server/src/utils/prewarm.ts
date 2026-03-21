import { proxyFetch } from './proxyFetch';

const PREWARM_URL = 'https://comix.to';
const INTERVAL_MS = 5_000;

let timer: ReturnType<typeof setInterval> | null = null;

async function ping() {
  try {
    const r = await proxyFetch(PREWARM_URL, { method: 'HEAD', cloudflareProtected: true });
    // Consume body to free resources
    await r.text();
  } catch {
    // proxyFetch already logs + triggers CF solve on block
  }
}

export function startPrewarm() {
  if (timer) return;
  console.log(`[prewarm] Keeping comix.to warm every ${INTERVAL_MS / 1000}s`);
  ping();
  timer = setInterval(ping, INTERVAL_MS);
  timer.unref();
}
