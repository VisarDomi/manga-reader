import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import type { FilterDefinition } from '@manga-reader/provider-types';
import type { RuntimeChapterImages, ServerMangaProvider } from './types.js';

const BASE_URL = 'https://mangadot.net';
const DOMAIN = 'mangadot.net';
const SEARCH_PAGE_SIZE = 100;

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

function sourceFromChapterPageUrl(pageUrl: string): string {
  try {
    return new URL(pageUrl).searchParams.get('source') || 'user';
  } catch {
    return 'user';
  }
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

function decodeStreamPool(data: unknown): unknown {
  if (typeof data !== 'string') return data;
  const pool = JSON.parse(data) as unknown[];
  const memo = new Map<number, unknown>();
  const decodeIndex = (index: number): unknown => {
    if (memo.has(index)) return memo.get(index);
    const value = pool[index];
    if (Array.isArray(value)) {
      const array: unknown[] = [];
      memo.set(index, array);
      for (const item of value) array.push(typeof item === 'number' ? decodeIndex(item) : item);
      return array;
    }
    if (value && typeof value === 'object') {
      const object: Record<string, unknown> = {};
      memo.set(index, object);
      for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
        const keyIndex = /^_(\d+)$/.exec(rawKey)?.[1];
        const key = keyIndex ? String(decodeIndex(Number(keyIndex))) : rawKey;
        object[key] = typeof rawValue === 'number' ? decodeIndex(rawValue) : rawValue;
      }
      return object;
    }
    return value;
  };
  return decodeIndex(0);
}

function findStringArray(root: unknown, key: string): string[] {
  const seen = new Set<unknown>();
  const stack = [root];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    if (Array.isArray(item)) {
      for (const value of item) stack.push(value);
      continue;
    }
    const record = item as Record<string, unknown>;
    const value = record[key];
    if (Array.isArray(value) && value.every(entry => typeof entry === 'string')) return value as string[];
    for (const child of Object.values(record)) stack.push(child);
  }
  return [];
}

function extractReactRouterStreamPayloads(html: string): string[] {
  const payloads: string[] = [];
  const pattern = /streamController\.enqueue\(("(?:\\.|[^"\\])*")\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    try {
      const payload = JSON.parse(match[1]) as unknown;
      if (typeof payload === 'string' && payload.trim().startsWith('[')) payloads.push(payload);
    } catch {
      // Ignore unrelated stream chunks.
    }
  }
  return payloads;
}

function mangadotGenreGroup(name: string): string {
  const value = name.toLowerCase();
  if (['shounen', 'shoujo', 'seinen', 'josei', 'seinin'].includes(value)) return 'demographic';
  if (['manga', 'manhwa', 'manhua', 'one shot', 'webtoon', 'comic', 'dojinshi'].includes(value)) return 'format';
  if ([
    'action', 'adventure', 'comedy', 'drama', 'fantasy', 'horror', 'mystery', 'romance',
    'sci-fi', 'slice of life', 'sports', 'supernatural', 'thriller',
  ].includes(value)) return 'genre';
  return 'theme';
}

function parseMangadotFilterCatalogDocument(html: string): FilterDefinition {
  const genres = new Map<string, { id: string; name: string; group: string }>();
  for (const payload of extractReactRouterStreamPayloads(html)) {
    try {
      const root = decodeStreamPool(payload);
      for (const name of findStringArray(root, 'allGenres')) {
        const clean = name.trim();
        if (!clean || genres.has(clean.toLowerCase())) continue;
        genres.set(clean.toLowerCase(), { id: clean, name: clean, group: mangadotGenreGroup(clean) });
      }
    } catch {
      // Keep scanning other stream chunks.
    }
  }
  if (genres.size === 0) throw new Error('Mangadot filter catalog missing allGenres');
  return {
    genres: [...genres.values()],
    demographics: [],
    types: [
      { id: 'JP', name: 'Manga' },
      { id: 'KR', name: 'Manhwa' },
      { id: 'CN', name: 'Manhua' },
      { id: 'ONESHOT', name: 'One Shot' },
    ],
    statuses: [
      { id: 'Ongoing', name: 'Ongoing' },
      { id: 'Completed', name: 'Completed' },
      { id: 'Hiatus', name: 'Hiatus' },
    ],
  };
}

async function fetchMangadotFilterCatalog(): Promise<FilterDefinition> {
  const started = Date.now();
  const response = await fetch(`${BASE_URL}/search`, {
    headers: {
      Accept: 'text/html',
      'User-Agent': 'Mozilla/5.0 manga-reader mangadot-filter-catalog',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  const filters = parseMangadotFilterCatalogDocument(html);
  console.log(`[provider:mangadotnet] filters refresh ok genres=${filters.genres.length} types=${filters.types?.length ?? 0} statuses=${filters.statuses?.length ?? 0} ${Date.now() - started}ms`);
  return filters;
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
  searchPageSize: SEARCH_PAGE_SIZE,
  commentsMode: 'page-document',
  browserProfileDir: path.join(os.homedir(), '.cloakbrowser-profiles', 'mangadot.net'),
  browserExecutablePath: '/usr/bin/chromium',
  browserInitTimeoutMs: 120_000,
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
          const timeoutMs = Number(options?.timeoutMs ?? 0);
          const controller = timeoutMs > 0 ? new AbortController() : null;
          const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
          let response: Response;
          try {
            response = await fetch(url.href, { credentials: 'include', signal: controller?.signal });
          } finally {
            if (timeout) clearTimeout(timeout);
          }
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

  newestSearchUrl(page: number, limit: number): string {
    const params = new URLSearchParams({
      search: '',
      page: String(pageNumber(page)),
      sortBy: 'latest',
      limit: String(limit > 0 ? limit : SEARCH_PAGE_SIZE),
    });
    return `${BASE_URL}/api/search?${params}`;
  },

  searchTransport(url: string) {
    const path = new URL(url).pathname;
    return path === '/search'
      ? { mode: 'runtime-document' as const, runtimePath: url }
      : { mode: 'runtime-api' as const, runtimePath: url };
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

  mangaCommentCountUrl(_numericMangaId: number, _pageUrl: string): string | null {
    return null;
  },

  mangaCommentsUrl(numericMangaId: number, _pageUrl: string): string {
    const params = new URLSearchParams({ manga_id: String(numericMangaId) });
    return `${BASE_URL}/api/comments?${params}`;
  },

  chapterCommentCountUrl(chapterId: string, _chapterNumber: number, _pageUrl: string): string {
    return `${BASE_URL}/api/comments/chapter/${encodeURIComponent(chapterId)}/count?source=user`;
  },

  chapterCommentsUrl(chapterId: string, _chapterNumber: number, pageUrl: string): string {
    const params = new URLSearchParams({ chapter_id: chapterId });
    const source = sourceFromChapterPageUrl(pageUrl);
    if (source) params.set('source', source);
    return `${BASE_URL}/api/comments?${params}`;
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

  filterCatalogDocumentUrl(): string {
    return `${BASE_URL}/search`;
  },

  parseFilterCatalogDocument(html: string): FilterDefinition {
    return parseMangadotFilterCatalogDocument(html);
  },

  async getFilterCatalog(): Promise<{ filters: FilterDefinition; source: 'cache' | 'upstream'; ageMs: number }> {
    return { filters: await fetchMangadotFilterCatalog(), source: 'upstream', ageMs: 0 };
  },
};

export function normalizeMangadotMangaDetail(data: unknown): Record<string, unknown> {
  return normalizeMangaDetail(asRecord(data) ?? {});
}
