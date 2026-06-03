import type {
  ChapterListPage,
  ChapterMeta,
  ChapterPage,
  FilterDefinition,
  HttpRequest,
  Manga,
  MangaProvider,
  PagedResult,
  PaginationMeta,
  SearchFilters,
} from '@manga-reader/provider-types';

const BASE_URL = 'https://mangadot.net';
const SEARCH_MAX_PAGE_SIZE = 100;

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

function absoluteUrl(url: string): string {
  if (!url) return '';
  return url.startsWith('http') ? url : `${BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

function numeric(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
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

function parseStreamPayload(data: unknown): unknown {
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

function findObjectWithArray(root: unknown, key: string): Record<string, unknown> | null {
  const seen = new Set<unknown>();
  const stack = [root];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    if (!Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      if (Array.isArray(record[key])) return record;
      for (const value of Object.values(record)) stack.push(value);
    } else {
      for (const value of item) stack.push(value);
    }
  }
  return null;
}

function looksLikeMangaCard(value: unknown): value is Record<string, unknown> {
  const record = asRecord(value);
  if (!record) return false;
  return record.id != null
    && typeof record.title === 'string'
    && (record.photo != null || record.cover != null || record.chapter_count != null);
}

function findMangaCards(root: unknown): Record<string, unknown>[] {
  const seen = new Set<unknown>();
  const byId = new Map<string, Record<string, unknown>>();
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
    if (looksLikeMangaCard(record)) {
      const id = firstString(record.id);
      if (id && !byId.has(id)) byId.set(id, record);
    }
    for (const value of Object.values(record)) stack.push(value);
  }
  return [...byId.values()];
}

function parseMangaItem(raw: Record<string, unknown>): Manga {
  const id = firstString(raw.id);
  const latestChapter = numeric(raw.chapter_count ?? raw.latestChapter ?? raw.latest_chapter);
  const authors = parseJsonList(raw.authors);
  const artists = parseJsonList(raw.artists);
  const authorList = [...authors, ...artists.filter(name => !authors.includes(name))];
  const genres = Array.isArray(raw.genres) ? raw.genres.filter((item): item is string => typeof item === 'string') : [];
  return {
    id,
    title: firstString(raw.title),
    cover: absoluteUrl(firstString(raw.photo, raw.cover)),
    latestChapter,
    author: authorList.length > 0 ? authorList.join(', ') : undefined,
    status: firstString(raw.status) || undefined,
    tags: genres.length > 0 ? genres : undefined,
    genres: genres.length > 0 ? genres : undefined,
    altTitles: Array.isArray(raw.alt_titles) ? raw.alt_titles.filter((item): item is string => typeof item === 'string') : undefined,
    description: firstString(raw.description) || undefined,
    authors: authorList.length > 0 ? authorList : undefined,
  };
}

function pagination(currentPage: number, total: number, pageSize = SEARCH_MAX_PAGE_SIZE): PaginationMeta {
  return {
    currentPage,
    lastPage: Math.max(1, Math.ceil(total / pageSize)),
    total,
  };
}

function parsePagination(raw: unknown, fallbackPage: number, fallbackCount: number): PaginationMeta {
  const record = asRecord(raw) ?? {};
  const currentPage = numeric(record.current_page ?? record.currentPage ?? record.page) ?? fallbackPage;
  const pageSize = numeric(record.per_page ?? record.perPage ?? record.page_size ?? record.limit) ?? SEARCH_MAX_PAGE_SIZE;
  const total = numeric(record.total ?? record.total_results ?? record.totalResults ?? record.total_items ?? record.totalItems ?? record.count);
  const lastPage = numeric(record.last_page ?? record.lastPage ?? record.total_pages ?? record.totalPages);
  if (total != null) {
    return {
      currentPage,
      lastPage: Math.max(1, Math.floor(lastPage ?? Math.ceil(total / pageSize))),
      total,
    };
  }
  if (lastPage != null) {
    return {
      currentPage,
      lastPage: Math.max(1, Math.floor(lastPage)),
      total: Math.max(fallbackCount, Math.floor(lastPage) * pageSize),
    };
  }
  return pagination(currentPage, fallbackCount, pageSize);
}

const filters: FilterDefinition = {
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
};

const provider: MangaProvider = {
  id: 'mangadotnet',
  name: 'Mangadotnet',
  baseUrl: BASE_URL,
  language: 'en',
  version: '1.0.0',
  nsfw: true,
  chapterImagesResponseType: 'json',

  getFilters(): FilterDefinition {
    return filters;
  },

  searchRequest(query: string, page: number, _filters?: SearchFilters): HttpRequest {
    const params = new URLSearchParams();
    const search = query.trim();
    params.set('search', search);
    if (search) {
      params.set('sortBy', 'relevance');
    } else {
      params.set('sortBy', 'latest');
    }
    params.set('page', String(page));
    params.set('limit', String(SEARCH_MAX_PAGE_SIZE));
    return { url: `${BASE_URL}/api/search?${params}`, cloudflareProtected: true };
  },

  parseSearchResponse(data: unknown): PagedResult<Manga> {
    const decoded = parseStreamPayload(data);
    const apiRoot = asRecord(decoded);
    const apiItems = Array.isArray(apiRoot?.manga_list)
      ? apiRoot.manga_list.filter((item): item is Record<string, unknown> => item != null && typeof item === 'object' && !Array.isArray(item))
      : null;
    const holder = apiItems ? null : findObjectWithArray(decoded, 'results');
    const rawItems = apiItems ?? (Array.isArray(holder?.results)
      ? holder.results.filter((item): item is Record<string, unknown> => item != null && typeof item === 'object' && !Array.isArray(item))
      : findMangaCards(decoded));
    const items = rawItems
      .map(parseMangaItem);
    const meta = parsePagination(apiRoot?.pagination ?? holder?.pagination ?? holder?.meta, numeric(apiRoot?.page ?? holder?.page ?? holder?.currentPage) ?? 1, items.length);
    return { items, pagination: meta, hasMore: meta.currentPage < meta.lastPage };
  },

  parseMangaDetailResponse(data: unknown): Partial<Manga> {
    const root = asRecord(data) ?? {};
    const result = asRecord(root.result) ?? root;
    const manga = asRecord(result.manga) ?? result;
    const recommendations = Array.isArray(result.recommendations)
      ? result.recommendations.filter((item): item is Record<string, unknown> => item != null && typeof item === 'object' && !Array.isArray(item)).map(parseMangaItem)
      : undefined;
    return {
      ...parseMangaItem(manga),
      recommendations,
    };
  },

  chapterListRequest(mangaId: string, _page: number): HttpRequest {
    return { url: `${BASE_URL}/api/manga/${encodeURIComponent(mangaId)}/chapters/list`, cloudflareProtected: true };
  },

  parseChapterListResponse(data: unknown): ChapterListPage {
    const root = asRecord(data) ?? {};
    const result = asRecord(root.result);
    const itemsRaw = Array.isArray(result?.items) ? result.items : Array.isArray(data) ? data : [];
    const items: ChapterMeta[] = itemsRaw
      .filter((item): item is Record<string, unknown> => item != null && typeof item === 'object' && !Array.isArray(item))
      .map(item => {
        const groupName = firstString(item.group_name, item.scanlator_name) || 'Unknown';
        const uploadedAt = typeof item.date_added === 'string' ? Math.floor(new Date(item.date_added).getTime() / 1000) : undefined;
        return {
          id: firstString(item.id),
          number: numeric(item.chapter_number) ?? 0,
          groupId: firstString(item.group_id) || undefined,
          groupName,
          uploadedAt,
          url: `${BASE_URL}/chapter/${encodeURIComponent(firstString(item.id))}?source=${encodeURIComponent(firstString(item.source) || 'user')}`,
        };
      });
    return {
      items,
      pagination: {
        currentPage: 1,
        lastPage: 1,
        total: items.length,
      },
    };
  },

  chapterImagesRequest(_mangaId: string, chapterId: string): HttpRequest {
    return { url: `${BASE_URL}/api/uploads/${encodeURIComponent(chapterId)}/images`, cloudflareProtected: true };
  },

  parseChapterImagesResponse(data: unknown): ChapterPage[] {
    const root = asRecord(data) ?? {};
    const result = asRecord(root.result) ?? root;
    const images = Array.isArray(result.pages)
      ? result.pages
      : Array.isArray(result.images)
        ? result.images
        : [];
    return images
      .filter((item): item is Record<string, unknown> => item != null && typeof item === 'object' && !Array.isArray(item))
      .map(item => {
        const url = absoluteUrl(firstString(item.url));
        return {
          url,
          candidates: url ? [url] : [],
          criticalCandidates: url ? [url] : [],
          width: numeric(item.w ?? item.width) ?? 0,
          height: numeric(item.h ?? item.height) ?? 0,
          scramble: false,
        };
      });
  },

  imageHeaders(): Record<string, string> {
    return { Referer: BASE_URL };
  },
};

export default provider;
