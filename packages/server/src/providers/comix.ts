import type { Page } from 'playwright';
import type { FilterDefinition, FilterOption } from '@manga-reader/provider-types';
import type { RuntimeChapterImages, ServerMangaProvider } from './types.js';

const BASE_URL = 'https://comix.to';
const DOMAIN = 'comix.to';
const SEARCH_PAGE_SIZE = 100;
const FILTER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const NSFW_NAMES = new Set(['Adult', 'Ecchi', 'Hentai', 'Mature', 'Smut']);

let filterCache: { filters: FilterDefinition; fetchedAt: number } | null = null;
let filterInflight: Promise<FilterDefinition> | null = null;

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

function asFilterOption(item: unknown, group?: string): FilterOption | null {
  const raw = asRecord(item);
  if (!raw) return null;
  const id = raw.id == null ? '' : String(raw.id);
  const name = typeof raw.label === 'string' ? raw.label : typeof raw.name === 'string' ? raw.name : '';
  if (!id || !name) return null;
  return {
    id,
    name,
    ...(group ? { group } : {}),
    ...(NSFW_NAMES.has(name) ? { nsfw: true as const } : {}),
  };
}

function filterOptionList(value: unknown, group?: string): FilterOption[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => asFilterOption(item, group)).filter((item): item is FilterOption => item != null);
}

function extractInitialData(html: string): Record<string, unknown> {
  const match = /<script[^>]+id=["']initial-data["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match?.[1]) throw new Error('initial-data script missing');
  return JSON.parse(match[1]) as Record<string, unknown>;
}

function parseFilters(html: string): FilterDefinition {
  const initial = extractInitialData(html);
  const list = asRecord(initial.list) ?? {};
  const options = asRecord(list.options) ?? {};
  const genres = [
    ...filterOptionList(options.genres, 'genre'),
    ...filterOptionList(options.formats, 'format'),
  ];
  const demographics = filterOptionList(options.demographics, 'demographic');
  const types = filterOptionList(options.types);
  const statuses = filterOptionList(options.statuses);

  if (genres.length === 0 || types.length === 0 || statuses.length === 0) {
    throw new Error(`incomplete filter catalog genres=${genres.length} types=${types.length} statuses=${statuses.length}`);
  }

  return {
    genres,
    ...(demographics.length > 0 ? { demographics } : {}),
    ...(types.length > 0 ? { types } : {}),
    ...(statuses.length > 0 ? { statuses } : {}),
  };
}

async function fetchFilterCatalog(): Promise<FilterDefinition> {
  const started = Date.now();
  const response = await fetch(`${BASE_URL}/browse`, {
    headers: {
      Accept: 'text/html',
      'User-Agent': 'Mozilla/5.0 manga-reader filter-catalog',
    },
  });
  if (!response.ok) throw new Error(`browse http=${response.status}`);
  const html = await response.text();
  const filters = parseFilters(html);
  console.log(`[provider:comix] filters refresh ok genres=${filters.genres.length} demographics=${filters.demographics?.length ?? 0} types=${filters.types?.length ?? 0} statuses=${filters.statuses?.length ?? 0} ${Date.now() - started}ms`);
  return filters;
}

function absoluteComixUrl(url: string): string {
  if (!url) return '';
  return url.startsWith('http') ? url : `${BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

export const comixServerProvider: ServerMangaProvider = {
  id: 'comix',
  name: 'Comix',
  domain: DOMAIN,
  baseUrl: BASE_URL,
  runtimeImageSource: 'runtime-http',
  imageDelivery: 'store-candidates',
  searchPageSize: SEARCH_PAGE_SIZE,
  searchRuntimeFallback: 'api',

  async resolveRuntimeHttpClient(page: Page, probeMangaId: string, owner: string): Promise<void> {
    const start = Date.now();
    const resolved = await page.evaluate(async ({ probeMangaId }) => {
      const global = globalThis as any;
      if (global.__providerRuntimeHttp?.get) {
        return {
          cached: true,
          mangaExportKey: global.__providerRuntimeMangaExportKey ?? 'cached',
          httpExportKey: global.__providerRuntimeHttpExportKey ?? 'cached',
          envUrl: global.__providerRuntimeEnvUrl ?? null,
        };
      }

      const mainScript = [...document.scripts]
        .map(s => s.src)
        .find(src => src.includes('/assets/build/') && src.includes('/dist/main-') && src.endsWith('.js'))
        ?? [...document.scripts]
          .map(s => s.src)
          .find(src => src.includes('/dist/main-') && src.endsWith('.js'));
      if (!mainScript) throw new Error('Comix main module not found');

      const mainText = await fetch(mainScript).then(response => response.text());
      const imports = [...mainText.matchAll(/from\s*["']([^"']+)["']/g)].map(match => match[1]);
      const envImport = imports.find(path => /env-.*\.js$/.test(path)) ?? imports.find(path => path.includes('env-'));
      if (!envImport) throw new Error('Comix env module import not found');

      const envUrl = new URL(envImport, mainScript).href;
      const mod = await import(envUrl);
      const entries = Object.entries(mod ?? {});
      const attempts: string[] = [];
      const mangaCandidates = entries.filter(([, value]) =>
        value
        && typeof value === 'object'
        && typeof (value as any).get === 'function'
        && typeof (value as any).list === 'function'
        && typeof (value as any).chapters === 'function'
      );
      const httpCandidates = entries.filter(([, value]) =>
        value
        && typeof value === 'object'
        && typeof (value as any).get === 'function'
        && typeof (value as any).post === 'function'
      );

      for (const [mangaKey, manga] of mangaCandidates) {
        for (const [httpKey, http] of httpCandidates) {
        try {
            const [detail, list, chapters] = await Promise.all([
              (manga as any).get(probeMangaId),
              (manga as any).list({ page: 1, limit: 1, order: { chapter_updated_at: 'desc' } }),
              (manga as any).chapters(probeMangaId, {
              limit: 1,
              page: 1,
              order: { number: 'desc' },
              }),
            ]);

            if (detail?.hid === probeMangaId && Array.isArray(list?.items) && Array.isArray(chapters?.items) && chapters?.meta && typeof chapters.meta === 'object') {
              global.__providerRuntimeManga = manga;
              global.__providerRuntimeHttp = http;
              global.__providerRuntimeMangaExportKey = mangaKey;
              global.__providerRuntimeHttpExportKey = httpKey;
              global.__providerRuntimeEnvUrl = envUrl;
              return {
                cached: false,
                mangaExportKey: mangaKey,
                httpExportKey: httpKey,
                envUrl,
              };
          }
            attempts.push(`${mangaKey}/${httpKey}:shape detail=${Object.keys(detail ?? {}).slice(0, 6).join(',') || 'empty'} list=${Object.keys(list ?? {}).slice(0, 6).join(',') || 'empty'} chapters=${Object.keys(chapters ?? {}).slice(0, 6).join(',') || 'empty'}`);
        } catch (e) {
            attempts.push(`${mangaKey}/${httpKey}:error=${String((e as Error)?.message ?? e).slice(0, 120)}`);
          }
        }
      }

      throw new Error(`Comix runtime HTTP client not found env=${envUrl} mangaCandidates=${mangaCandidates.map(([key]) => key).join(',') || 'none'} httpCandidates=${httpCandidates.map(([key]) => key).join(',') || 'none'} exports=${entries.map(([key]) => key).join(',') || 'none'} attempts=${attempts.join(' ') || 'none'}`);
    }, { probeMangaId });
    console.log(`[provider:${this.id}] runtime-http-resolver ${owner} ${probeMangaId} cached=${resolved.cached ? 'yes' : 'no'} mangaExport=${resolved.mangaExportKey} httpExport=${resolved.httpExportKey} env=${resolved.envUrl ?? 'unknown'} ${Date.now() - start}ms`);
  },

  runtimePageUrl(mangaId: string): string {
    return `${BASE_URL}/title/${mangaId}`;
  },

  mangaDetailPath(mangaId: string): string {
    return `/manga/${mangaId}`;
  },

  mangaRecommendationsPath(mangaId: string): string {
    return `/manga/${mangaId}/recommended`;
  },

  chapterListPath(mangaId: string): string {
    return `/manga/${mangaId}/chapters`;
  },

  chapterListParams(page: number, pageSize: number): Record<string, unknown> {
    return {
      limit: pageSize,
      page,
      order: { number: 'desc' },
    };
  },

  chapterImagesPath(chapterId: string): string {
    return `/chapters/${chapterId}`;
  },

  normalizeChapterImages(detail: Record<string, unknown>): RuntimeChapterImages {
    const pagesData = asRecord(detail.pages);
    const baseUrl = typeof pagesData?.baseUrl === 'string' ? pagesData.baseUrl : '';
    const scrambledBaseUrl = baseUrl.replace(/\/i\/(?=[bh])/, '/si/');
    const items = Array.isArray(pagesData?.items) ? pagesData.items : [];
    const pages = items
      .map((item: unknown) => {
        const raw = asRecord(item);
        const relativeUrl = typeof raw?.url === 'string' ? raw.url : '';
        const scramble = raw?.s === 1 || raw?.s === '1' || raw?.scramble === true;
        const pageBaseUrl = scramble ? scrambledBaseUrl : baseUrl;
        const url = relativeUrl
          ? relativeUrl.startsWith('http')
            ? relativeUrl
            : pageBaseUrl
              ? new URL(relativeUrl, pageBaseUrl).toString()
              : ''
          : '';
        return {
          url,
          width: Number(raw?.width ?? 0),
          height: Number(raw?.height ?? 0),
          scramble,
        };
      })
      .filter(item => item.url);
    return { source: this.runtimeImageSource, schemaVersion: 2, targetCount: items.length, pages };
  },

  newestSearchUrl(page: number, limit: number): string {
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('limit', String(limit));
    params.set('order[chapter_updated_at]', 'desc');
    return `${BASE_URL}/api/v1/manga?${params}`;
  },

  searchRuntimePath(url: string): string {
    const parsed = new URL(url);
    const prefix = '/api/v1';
    const pathname = parsed.pathname.startsWith(prefix)
      ? parsed.pathname.slice(prefix.length) || '/'
      : parsed.pathname;
    return `${pathname}${parsed.search}`;
  },

  mangaPageUrl(mangaId: string, rawUrl?: unknown): string {
    return typeof rawUrl === 'string' && rawUrl.length > 0 ? absoluteComixUrl(rawUrl) : `${BASE_URL}/title/${mangaId}`;
  },

  chapterPageUrl(mangaId: string, chapterId: string, chapterNumber: number, rawUrl?: unknown): string {
    if (typeof rawUrl === 'string' && rawUrl.length > 0) return absoluteComixUrl(rawUrl);
    return `${BASE_URL}/title/${mangaId}/${chapterId}-chapter-${chapterNumber}`;
  },

  commentsLookupUrl(pageIdentifier: string, pageUrl: string): string {
    const params = new URLSearchParams({
      page_identifier: pageIdentifier,
      page_url: pageUrl,
    });
    return `${BASE_URL}/api/v1/threads/lookup?${params}`;
  },

  commentsPageUrl(threadId: number): string {
    return `${BASE_URL}/api/v1/threads/${Math.floor(threadId)}/comments`;
  },

  commentTreeUrl(commentId: number): string {
    return `${BASE_URL}/api/v1/comments/${commentId}`;
  },

  mangaCommentIdentifier(numericMangaId: number): string {
    return `manga${Math.floor(numericMangaId)}`;
  },

  chapterCommentIdentifier(numericMangaId: number, chapterNumber: number): string {
    return `manga${Math.floor(numericMangaId)}_chap${chapterNumber}_vol0`;
  },

  absoluteUrl(url: string): string {
    return absoluteComixUrl(url);
  },

  searchThumbnailReferer(): string {
    return BASE_URL;
  },

  rawMangaUrlFromChapterItem(item: unknown, mangaId: string, chapterId: string, chapterNumber?: number): string {
    const raw = asRecord(item);
    const value = raw?.url ?? raw?.path ?? raw?.slug;
    if (typeof value === 'string' && value.startsWith('http')) return value;
    if (typeof value === 'string' && value.startsWith('/')) return absoluteComixUrl(value);
    const chapterPart = chapterNumber === undefined ? chapterId : `${chapterId}-chapter-${chapterNumber}`;
    return `${BASE_URL}/title/${mangaId}/${chapterPart}`;
  },

  async getFilterCatalog(): Promise<{ filters: FilterDefinition; source: 'cache' | 'upstream'; ageMs: number }> {
    const now = Date.now();
    if (filterCache && now - filterCache.fetchedAt < FILTER_CACHE_TTL_MS) {
      return { filters: filterCache.filters, source: 'cache', ageMs: now - filterCache.fetchedAt };
    }

    filterInflight ??= fetchFilterCatalog()
      .then(filters => {
        filterCache = { filters, fetchedAt: Date.now() };
        return filters;
      })
      .finally(() => {
        filterInflight = null;
      });

    try {
      const filters = await filterInflight;
      return { filters, source: 'upstream', ageMs: 0 };
    } catch (error) {
      if (filterCache) {
        console.log(`[provider:comix] filters refresh failed using stale cache ageMs=${now - filterCache.fetchedAt} error=${String((error as Error)?.message ?? error)}`);
        return { filters: filterCache.filters, source: 'cache', ageMs: now - filterCache.fetchedAt };
      }
      throw error;
    }
  },

};
