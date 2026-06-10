import crypto from 'node:crypto';
import type { Page } from 'playwright';
import type { FilterDefinition } from '@manga-reader/provider-types';
import type { RuntimeChapterImages, ServerMangaProvider } from './types.js';

const BASE_URL = 'https://mangataro.org';
const DOMAIN = 'mangataro.org';
const SEARCH_PAGE_SIZE = 24;

function absoluteUrl(url: string): string {
  if (!url) return '';
  return url.startsWith('http') ? url : `${BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function numeric(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function generateToken(): { token: string; timestamp: number } {
  const timestamp = Math.floor(Date.now() / 1000);
  const hour = new Date().toISOString().slice(0, 13).replace(/[-T:]/g, '');
  const secret = 'mng_ch_' + hour;
  const hash = crypto.createHash('md5').update(String(timestamp) + secret).digest('hex').substring(0, 16);
  return { token: hash, timestamp };
}

export const mangataroServerProvider: ServerMangaProvider = {
  id: 'mangataro',
  name: 'MangaTaro',
  domain: DOMAIN,
  baseUrl: BASE_URL,
  runtimeImageSource: 'mangataro-api',
  chapterImageSchemaVersion: 1,
  imageDelivery: 'direct',
  byteFetchMode: 'proxy',
  commentsFetchMode: 'proxy',
  runtimeProbeMangaId: '684584',
  searchPageSize: SEARCH_PAGE_SIZE,

  async resolveRuntimeHttpClient(page: Page, probeMangaId: string, owner: string): Promise<void> {
    const start = Date.now();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const resolved = await page.evaluate(({ baseUrl }) => {
      const global = globalThis as any;
      if (global.__providerRuntimeHttp?.get && global.__providerRuntimeProviderId === 'mangataro') {
        return { cached: true };
      }

      global.__providerRuntimeProviderId = 'mangataro';
      global.__providerRuntimeHttp = {
        async get(apiPath: string, options?: { params?: Record<string, unknown>; timeoutMs?: number }) {
          const url = new URL(apiPath, baseUrl);
          const params = options?.params ?? {};
          for (const [key, value] of Object.entries(params)) {
            if (value == null) continue;
            if (Array.isArray(value)) {
              for (const item of value) url.searchParams.append(key, String(item));
            } else {
              url.searchParams.set(key, String(value));
            }
          }

          const controller = options?.timeoutMs ? new AbortController() : null;
          const timeout = controller ? setTimeout(() => controller.abort(), options!.timeoutMs!) : null;
          let response: Response;
          try {
            response = await fetch(url.href, { credentials: 'include', signal: controller?.signal });
          } finally {
            if (timeout) clearTimeout(timeout);
          }
          const contentType = response.headers.get('content-type') ?? '';
          const text = await response.text();
          if (!response.ok) throw new Error(`MangaTaro API http=${response.status} path=${apiPath} body=${text.slice(0, 160)}`);

            if (contentType.includes('application/json')) {
            const parsed = JSON.parse(text);

            // Normalize chapter list response to { items: [...] } shape
            if (parsed.chapters && !parsed.items) {
              return {
                items: parsed.chapters.map((ch: Record<string, unknown>) => {
                  const num = parseFloat(String(ch.chapter ?? '0'));
                  const numericId = String(ch.id ?? '');
                  const url = String(ch.url ?? '');
                  // Extract slug from url to create compound id
                  const slug = url.replace(/https?:\/\/[^\/]+\/read\//, '').replace(/\/ch\d+-.*$/, '');
                  const compoundId = slug && num ? `${slug}:${num}:${numericId}` : numericId;
                  return {
                    chapter_id: compoundId,
                    id: compoundId,
                    number: num,
                    group_name: String(ch.group_name ?? 'Unknown'),
                    group_id: ch.group_id ? String(ch.group_id) : undefined,
                    url,
                    page_count: ch.page_count ? Number(ch.page_count) : undefined,
                    created_at: ch.date_added ? Number(ch.date_added) : undefined,
                  };
                }),
                pagination: {
                  currentPage: 1,
                  lastPage: 1,
                  total: parsed.total || (parsed.chapters || []).length,
                },
              };
            }

            return parsed;
          }

          // Chapter page HTML — return as object with html key for normalizeChapterImages
          if (apiPath.includes('/read/')) {
            return { html: text };
          }

          return text;
        },
      };
      return { cached: false };
    }, { baseUrl: BASE_URL });

    console.log(`[provider:mangataro] browser-fetch-resolver ${owner} ${probeMangaId} cached=${resolved.cached ? 'yes' : 'no'} ${Date.now() - start}ms`);
  },

  runtimePageUrl(_mangaId: string): string {
    return `${BASE_URL}/`;
  },

  mangaDetailPath(mangaId: string): string {
    // Use WP REST API which accepts numeric ID
    return `/wp-json/wp/v2/manga/${encodeURIComponent(mangaId)}`;
  },

  mangaRecommendationsPath(_mangaId: string): string {
    return '';
  },

  normalizeMangaDetail(detail: Record<string, unknown>, _recommendations: unknown[]): unknown {
    const manga = asRecord(detail) ?? {};
    const titleRendered = String(asRecord(manga.title)?.rendered ?? '');
    const contentRendered = String(asRecord(manga.content)?.rendered ?? '');
    const description = contentRendered.replace(/<[^>]*>/g, '').trim() || '';
    const links = asRecord(manga._links);
    const featured = Array.isArray(links?.['wp:featuredmedia']) ? links['wp:featuredmedia'][0] : undefined;
    const coverHref = asRecord(featured)?.href ?? '';
    const featuredId = Number(manga.featured_media ?? 0);

    // Extract tags from class_list (tag-adventure -> adventure)
    const classList = Array.isArray(manga.class_list) ? manga.class_list as string[] : [];
    const tags = classList
      .filter((c: string) => c.startsWith('tag-'))
      .map((c: string) => c.replace('tag-', ''))
      .filter(Boolean);

    // Extract type from class_list (type-manga -> manga)
    const typeEntry = classList.find((c: string) => c.startsWith('type-'));
    const type = typeEntry ? typeEntry.replace('type-', '') : undefined;

    // Extract author from class_list (manga_author-name)
    const authorEntry = classList.find((c: string) => c.startsWith('manga_author-'));
    const author = authorEntry ? authorEntry.replace('manga_author-', '') : undefined;

    return {
      status: 'ok',
      result: {
        id: String(manga.id ?? ''),
        slug: String(manga.slug ?? ''),
        title: titleRendered,
        cover: absoluteUrl(String(coverHref)),
        description,
        tags,
        genres: tags,
        type,
        author,
      },
    };
  },

  chapterListPath(mangaId: string): string {
    const { token, timestamp } = generateToken();
    const params = new URLSearchParams({
      manga_id: mangaId,
      offset: '0',
      limit: '500',
      order: 'DESC',
      _t: token,
      _ts: String(timestamp),
    });
    return `/auth/manga-chapters?${params}`;
  },

  chapterListParams(_page: number, _pageSize: number): Record<string, unknown> {
    return { limit: '500', order: 'DESC' };
  },

  chapterImagesPath(chapterId: string): string {
    const parts = chapterId.split(':');
    if (parts.length === 3) {
      const [slug, num, id] = parts;
      return `/read/${slug}/ch${num}-${id}`;
    }
    return `/read/${chapterId}`;
  },

  normalizeChapterImages(detail: Record<string, unknown>): RuntimeChapterImages {
    const html = typeof detail === 'string' ? detail : String((detail as any)?.html ?? detail?.body ?? '');
    const urls = new Set<string>();
    const pattern = /https:\/\/mangataro\.yachts\/storage\/chapters\/[a-f0-9]+\/\d+\.webp/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      urls.add(match[0]);
    }
    const pages = Array.from(urls).map(url => ({
      url,
      width: 0,
      height: 0,
      scramble: false,
    }));
    return {
      source: this.runtimeImageSource,
      targetCount: pages.length,
      schemaVersion: this.chapterImageSchemaVersion,
      pages,
    };
  },

  async fetchRuntimeChapterImages(page: Page, chapterUrl: string, timeoutMs?: number): Promise<RuntimeChapterImages> {
    const navTimeout = timeoutMs ?? 45_000;
    await page.goto(chapterUrl, { waitUntil: 'domcontentloaded', timeout: navTimeout });
    await page.waitForTimeout(3000);
    // Scroll through the page to trigger lazy loading
    await page.evaluate(async () => {
      const distance = 800;
      const delay = 200;
      const totalHeight = document.body.scrollHeight || 10000;
      let scrolled = 0;
      while (scrolled < totalHeight) {
        window.scrollBy(0, distance);
        scrolled += distance;
        await new Promise(r => setTimeout(r, delay));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(2000);

    const urls = await page.evaluate(() => {
      const seen = new Set<string>();
      const imgs = document.querySelectorAll<HTMLImageElement>('img.comic-image, img[src*="mangataro.yachts"], img[data-src*="mangataro.yachts"]');
      imgs.forEach(img => {
        const src = img.src || img.getAttribute('data-src') || '';
        if (src && src.includes('mangataro.yachts') && src.endsWith('.webp')) {
          seen.add(src);
        }
      });
      return Array.from(seen);
    });

    const pages = urls.map(url => ({
      url,
      width: 0,
      height: 0,
      scramble: false,
    }));
    return {
      source: this.runtimeImageSource,
      targetCount: pages.length,
      schemaVersion: this.chapterImageSchemaVersion,
      pages,
    };
  },

  newestSearchUrl(page: number, limit: number): string {
    return `${BASE_URL}/wp-json/wp/v2/manga?per_page=${limit}&page=${page}&_embed=wp:featuredmedia`;
  },

  searchTransport(_url: string) {
    return { mode: 'proxy' as const };
  },

  mangaPageUrl(mangaId: string, _rawUrl?: unknown): string {
    return `${BASE_URL}/manga/${mangaId}`;
  },

  chapterPageUrl(_mangaId: string, chapterId: string, _chapterNumber: number, rawUrl?: unknown): string {
    if (typeof rawUrl === 'string' && rawUrl.length > 0) return absoluteUrl(rawUrl);
    const parts = chapterId.split(':');
    if (parts.length === 3) {
      const [slug, num, id] = parts;
      return `${BASE_URL}/read/${slug}/ch${num}-${id}`;
    }
    return `${BASE_URL}/read/${chapterId}`;
  },

  commentsLookupUrl(pageIdentifier: string, _pageUrl: string): string {
    return `${BASE_URL}/wp-json/wp/v2/comments?post=${encodeURIComponent(pageIdentifier)}&per_page=50`;
  },

  commentsPageUrl(threadId: number): string {
    return `${BASE_URL}/wp-json/wp/v2/comments/${threadId}`;
  },

  commentTreeUrl(commentId: number): string {
    return `${BASE_URL}/wp-json/wp/v2/comments/${commentId}`;
  },

  mangaCommentIdentifier(numericMangaId: number): string {
    return String(numericMangaId);
  },

  chapterCommentIdentifier(numericMangaId: number, _chapterNumber: number): string {
    return String(numericMangaId);
  },

  mangaCommentCountUrl(_numericMangaId: number, _pageUrl: string): string | null {
    return null;
  },

  mangaCommentsUrl(numericMangaId: number, _pageUrl: string): string | null {
    return `${BASE_URL}/wp-json/wp/v2/comments?post=${numericMangaId}&per_page=50`;
  },

  chapterCommentCountUrl(_chapterId: string, _chapterNumber: number, _pageUrl: string): string | null {
    return null;
  },

  chapterCommentsUrl(_chapterId: string, _chapterNumber: number, _pageUrl: string): string | null {
    return null;
  },

  absoluteUrl(url: string): string {
    return absoluteUrl(url);
  },

  searchThumbnailReferer(): string {
    return BASE_URL;
  },

  rawMangaUrlFromChapterItem(item: unknown, _mangaId: string, _chapterId: string, _chapterNumber?: number): string {
    const raw = asRecord(item);
    return firstString(raw?.url);
  },

  async getFilterCatalog(): Promise<{ filters: FilterDefinition; source: 'cache' | 'upstream'; ageMs: number }> {
    return {
      filters: {
        genres: [],
        types: [
          { id: 'Manga', name: 'Manga' },
          { id: 'Manhwa', name: 'Manhwa' },
          { id: 'Manhua', name: 'Manhua' },
          { id: 'Webtoon', name: 'Webtoon' },
          { id: 'One-shot', name: 'One Shot' },
        ],
        statuses: [
          { id: 'Ongoing', name: 'Ongoing' },
          { id: 'Completed', name: 'Completed' },
          { id: 'Hiatus', name: 'Hiatus' },
        ],
      },
      source: 'cache',
      ageMs: 0,
    };
  },
};
