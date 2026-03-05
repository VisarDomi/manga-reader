import { chromium } from 'playwright';
import { USER_AGENT } from '../config';

interface CachedCookies {
  cookieHeader: string;
  obtainedAt: number;
}

const cookieCache = new Map<string, CachedCookies>();
const solvingDomains = new Set<string>();

export function isCloudflareBlock(status: number, serverHeader: string | null): boolean {
  return (status === 403 || status === 503) && (serverHeader ?? '').toLowerCase().includes('cloudflare');
}

export function getCachedCookies(domain: string): string | null {
  const cached = cookieCache.get(domain);
  if (!cached) return null;
  // Expire after 30 minutes
  if (Date.now() - cached.obtainedAt > 30 * 60 * 1000) {
    cookieCache.delete(domain);
    return null;
  }
  return cached.cookieHeader;
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

  let browser;
  try {
    browser = await chromium.launch({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--window-size=1920,1080',
      ],
    });

    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1920, height: 1080 },
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Poll for cf_clearance cookie up to 30 seconds
    let cookieHeader: string | null = null;
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
      const cookies = await context.cookies();
      const cfCookie = cookies.find(c => c.name === 'cf_clearance');
      if (cfCookie) {
        // Collect all cookies for the domain
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
    cookieCache.set(domain, { cookieHeader, obtainedAt: Date.now() });
    return cookieHeader;
  } finally {
    solvingDomains.delete(domain);
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
