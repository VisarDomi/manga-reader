import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';

const CLOAKBROWSER_PATH = path.join(os.homedir(), '.cloakbrowser/chromium-145.0.7632.159.7/chrome');
const PROFILE_DIR = path.join(os.homedir(), '.cloakbrowser-profiles');

const STEALTH_ARGS = [
  '--no-sandbox',
  '--disable-blink-features=AutomationControlled',
  '--fingerprint=52495',
  '--fingerprint-platform=windows',
  '--fingerprint-gpu-vendor=Google Inc. (NVIDIA)',
  '--fingerprint-gpu-renderer=ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 (0x00002484) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  '--ignore-gpu-blocklist',
  '--window-size=1920,1080',
];

const IGNORE_DEFAULT_ARGS = ['--enable-automation', '--enable-unsafe-swiftshader'];

interface CachedCookies {
  cookieHeader: string;
  userAgent: string;
  obtainedAt: number;
}

const cookieCache = new Map<string, CachedCookies>();
const solvingDomains = new Set<string>();

function findCached(domain: string): CachedCookies | null {
  let cached = cookieCache.get(domain);
  if (!cached) {
    const parts = domain.split('.');
    if (parts.length > 2) {
      const parent = parts.slice(1).join('.');
      cached = cookieCache.get(parent);
    }
  }
  if (!cached) return null;
  if (Date.now() - cached.obtainedAt > 30 * 60 * 1000) {
    cookieCache.delete(domain);
    return null;
  }
  return cached;
}

export function isCloudflareBlock(status: number, serverHeader: string | null): boolean {
  return (status === 403 || status === 503) && (serverHeader ?? '').toLowerCase().includes('cloudflare');
}

export function getCachedCookies(domain: string): string | null {
  return findCached(domain)?.cookieHeader ?? null;
}

export function getCachedUserAgent(domain: string): string | null {
  return findCached(domain)?.userAgent ?? null;
}

export function clearCachedCookies(domain: string): void {
  cookieCache.delete(domain);
}

export function isSolving(domain: string): boolean {
  return solvingDomains.has(domain);
}

export async function solveCloudflareCookies(url: string): Promise<string> {
  const domain = new URL(url).hostname;

  if (solvingDomains.has(domain)) {
    throw new Error(`Already solving for ${domain}`);
  }

  solvingDomains.add(domain);
  console.log(`[cloudflare] Starting solve for ${domain}`);

  const profileDir = path.join(PROFILE_DIR, domain);
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath: CLOAKBROWSER_PATH,
      args: STEALTH_ARGS,
      ignoreDefaultArgs: IGNORE_DEFAULT_ARGS,
      headless: false,
      viewport: { width: 1920, height: 1080 },
    });

    const existingCookies = await context.cookies();
    const staleCf = existingCookies.filter(c => c.name === 'cf_clearance');
    if (staleCf.length > 0) {
      await context.clearCookies({ name: 'cf_clearance' });
      console.log(`[cloudflare] Cleared ${staleCf.length} stale cf_clearance cookie(s) for ${domain}`);
    }

    const page = context.pages()[0] || await context.newPage();

    const browserUA = await page.evaluate(() => navigator.userAgent);
    console.log(`[cloudflare] Browser UA: ${browserUA}`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    let cookieHeader: string | null = null;
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
      const cookies = await context.cookies();
      const cfCookie = cookies.find(c => c.name === 'cf_clearance');
      if (cfCookie) {
        const domainCookies = cookies.filter(c =>
          domain.endsWith(c.domain.replace(/^\./, ''))
        );
        cookieHeader = domainCookies.map(c => `${c.name}=${c.value}`).join('; ');
        break;
      }
      await page.waitForTimeout(1000);
    }

    if (!cookieHeader) {
      throw new Error(`Cloudflare solve timed out for ${domain}`);
    }

    console.log(`[cloudflare] Solved for ${domain}`);
    cookieCache.set(domain, { cookieHeader, userAgent: browserUA, obtainedAt: Date.now() });
    return cookieHeader;
  } finally {
    solvingDomains.delete(domain);
    if (context) {
      await context.close().catch(() => {});
    }
  }
}
