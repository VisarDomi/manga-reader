import type { Page } from 'playwright';
import type { FilterDefinition } from '@manga-reader/provider-types';
import type { RuntimeChapterImages, ServerMangaProvider } from './types.js';

const BASE_URL = 'https://mangadot.net';
const DOMAIN = 'mangadot.net';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function absoluteMangadotUrl(url: string): string {
  if (!url) return '';
  return url.startsWith('http') ? url : `${BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

function pageNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function numericIdFromChapterItem(item: unknown): string {
  const raw = asRecord(item);
  return firstString(raw?.id, raw?.chapter_id);
}

function chapterSourceFromItem(item: unknown): string {
  const raw = asRecord(item);
  return firstString(raw?.source) || 'user';
}

function chapterNumberPathPart(value: unknown): string {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return 'unknown';
  return Number.isInteger(n) ? String(n) : String(n).replace('.', '_');
}

function parseJsonList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
  } catch {
    return [];
  }
}

function normalizeMangaDetail(raw: Record<string, unknown>): Record<string, unknown> {
  const manga = asRecord(raw.manga) ?? raw;
  const recommendations = Array.isArray(raw.suggestions)
    ? raw.suggestions
    : Array.isArray(raw.recommendations)
      ? raw.recommendations
      : [];
  const authors = parseJsonList(manga.authors);
  const artists = parseJsonList(manga.artists);
  const photo = firstString(manga.photo);
  return {
    status: 'ok',
    result: {
      ...manga,
      hid: firstString(manga.id),
      hash_id: firstString(manga.id),
      title: firstString(manga.title),
      poster: {
        small: absoluteMangadotUrl(photo),
        medium: absoluteMangadotUrl(photo),
        large: absoluteMangadotUrl(photo),
      },
      synopsis: firstString(manga.description),
      description: firstString(manga.description),
      latest_chapter: manga.chapter_count != null ? Number(manga.chapter_count) : null,
      latestChapter: manga.chapter_count != null ? Number(manga.chapter_count) : null,
      authors,
      artists,
      recommendations,
    },
  };
}

export const mangadotnetServerProvider: ServerMangaProvider = {
  id: 'mangadotnet',
  name: 'Mangadotnet',
  domain: DOMAIN,
  baseUrl: BASE_URL,
  runtimeImageSource: 'mangadotnet-api',
  imageDelivery: 'direct',
  browserProfileDir: '/tmp/mangadot-human-profile',
  browserExecutablePath: '/usr/bin/chromium',
  runtimeProbeMangaId: '118',
  runtimePageTimeoutMs: 45_000,

  async resolveRuntimeHttpClient(page: Page, probeMangaId: string, owner: string): Promise<void> {
    const start = Date.now();
    const resolved = await page.evaluate(async ({ baseUrl, probeMangaId }) => {
      const global = globalThis as any;
      if (global.__providerRuntimeHttp?.get && global.__providerRuntimeProviderId === 'mangadotnet') {
        return { cached: true };
      }

      const probe = await fetch(`${baseUrl}/api/manga/${encodeURIComponent(probeMangaId)}`, {
        credentials: 'include',
      });
      if (!probe.ok) {
        const text = await probe.text().catch(() => '');
        throw new Error(`Mangadot session unavailable http=${probe.status} body=${text.slice(0, 160)}`);
      }

      global.__providerRuntimeProviderId = 'mangadotnet';
      global.__providerRuntimeHttp = {
        async get(apiPath: string, options?: { params?: Record<string, unknown> }) {
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
          const response = await fetch(url.href, { credentials: 'include' });
          const contentType = response.headers.get('content-type') ?? '';
          const text = await response.text();
          if (!response.ok) throw new Error(`Mangadot API http=${response.status} path=${apiPath} body=${text.slice(0, 160)}`);
          if (contentType.includes('application/json')) return JSON.parse(text);
          return text;
        },
      };
      return { cached: false };
    }, { baseUrl: BASE_URL, probeMangaId });
    console.log(`[provider:${this.id}] browser-fetch-resolver ${owner} ${probeMangaId} cached=${resolved.cached ? 'yes' : 'no'} ${Date.now() - start}ms`);
  },

  runtimePageUrl(mangaId: string): string {
    return `${BASE_URL}/manga/${encodeURIComponent(mangaId)}`;
  },

  mangaDetailPath(mangaId: string): string {
    return `/api/manga/${encodeURIComponent(mangaId)}`;
  },

  mangaRecommendationsPath(mangaId: string): string {
    return `/manga/${encodeURIComponent(mangaId)}.data`;
  },

  normalizeMangaDetail(detail: Record<string, unknown>, recommendations: unknown[]): unknown {
    const normalized = normalizeMangaDetail({ ...detail, recommendations });
    const result = asRecord(normalized.result) ?? {};
    return {
      ...normalized,
      result: {
        ...result,
        recommendations,
      },
    };
  },

  chapterListPath(mangaId: string): string {
    return `/api/manga/${encodeURIComponent(mangaId)}/chapters/list`;
  },

  chapterListParams(_page: number, _pageSize: number): Record<string, unknown> {
    return {};
  },

  chapterImagesPath(chapterId: string): string {
    return `/api/uploads/${encodeURIComponent(chapterId)}/images`;
  },

  normalizeChapterImages(detail: Record<string, unknown>): RuntimeChapterImages {
    const images = Array.isArray(detail.images) ? detail.images : [];
    const pages = images
      .map((item: unknown) => {
        const raw = asRecord(item);
        const url = firstString(raw?.url);
        const width = Number(raw?.w ?? raw?.width ?? 0);
        const height = Number(raw?.h ?? raw?.height ?? 0);
        if (!url || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
        return { url: absoluteMangadotUrl(url), width, height, scramble: false };
      })
      .filter((item): item is { url: string; width: number; height: number; scramble: boolean } => item != null);
    const targetCount = Number(asRecord(detail.chapter)?.page_count ?? pages.length);
    return {
      source: this.runtimeImageSource,
      schemaVersion: 2,
      targetCount: Number.isFinite(targetCount) && targetCount > 0 ? targetCount : pages.length,
      pages,
    };
  },

  newestSearchUrl(page: number, _limit: number): string {
    const params = new URLSearchParams({
      search: '',
      page: String(pageNumber(page)),
      sortBy: 'latest',
    });
    return `${BASE_URL}/api/search?${params}`;
  },

  mangaPageUrl(mangaId: string, _rawUrl?: unknown): string {
    return `${BASE_URL}/manga/${encodeURIComponent(mangaId)}`;
  },

  chapterPageUrl(_mangaId: string, chapterId: string, _chapterNumber: number, rawUrl?: unknown): string {
    if (typeof rawUrl === 'string' && rawUrl.length > 0) return absoluteMangadotUrl(rawUrl);
    return `${BASE_URL}/chapter/${encodeURIComponent(chapterId)}?source=user`;
  },

  commentsLookupUrl(pageIdentifier: string, _pageUrl: string): string {
    return `${BASE_URL}/api/comments/${pageIdentifier}`;
  },

  commentsPageUrl(threadId: number): string {
    return `${BASE_URL}/api/comments/${threadId}`;
  },

  commentTreeUrl(commentId: number): string {
    return `${BASE_URL}/api/comments/${commentId}`;
  },

  mangaCommentIdentifier(numericMangaId: number): string {
    return `manga/${numericMangaId}`;
  },

  chapterCommentIdentifier(_numericMangaId: number, chapterNumber: number): string {
    return `chapter/${chapterNumber}`;
  },

  absoluteUrl(url: string): string {
    return absoluteMangadotUrl(url);
  },

  searchThumbnailReferer(): string {
    return BASE_URL;
  },

  rawMangaUrlFromChapterItem(item: unknown, _mangaId: string, chapterId: string, chapterNumber?: number): string {
    const raw = asRecord(item);
    const id = numericIdFromChapterItem(item) || chapterId;
    const source = chapterSourceFromItem(item);
    const number = chapterNumberPathPart(raw?.chapter_number ?? chapterNumber);
    return `${BASE_URL}/chapter/${encodeURIComponent(id)}?source=${encodeURIComponent(source)}#chapter=${number}`;
  },

  async getFilterCatalog(): Promise<{ filters: FilterDefinition; source: 'cache' | 'upstream'; ageMs: number }> {
    return {
      source: 'cache',
      ageMs: 0,
      filters: {
        genres: [],
        types: [
          { id: 'all', name: 'All' },
          { id: 'manga', name: 'Manga' },
          { id: 'manhwa', name: 'Manhwa' },
          { id: 'manhua', name: 'Manhua' },
          { id: 'one-shot', name: 'One Shot' },
        ],
        statuses: [
          { id: 'any', name: 'Any' },
          { id: 'ongoing', name: 'Ongoing' },
          { id: 'completed', name: 'Completed' },
          { id: 'hiatus', name: 'Hiatus' },
        ],
      },
    };
  },

  filterSearchUrl(_type: string, keyword: string): string | null {
    const params = new URLSearchParams({ search: keyword, page: '1', sortBy: 'relevance' });
    return `${BASE_URL}/api/search?${params}`;
  },
};

export function normalizeMangadotMangaDetail(data: unknown): Record<string, unknown> {
  return normalizeMangaDetail(asRecord(data) ?? {});
}
