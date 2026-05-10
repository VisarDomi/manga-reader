import type { MangaProvider, Manga, ChapterMeta, ChapterPage, ChapterListPage, PaginationMeta, SearchFilters, PagedResult, FilterDefinition, HttpRequest } from '@manga-reader/provider-types';
import { TERMS, defaultFilterDefinition } from './terms.js';
import { extractJsonArray } from './parse.js';

const BASE_URL = 'https://comix.to';
const API_URL = `${BASE_URL}/api/v1`;
const SEARCH_LIMIT = 100;

let activeFilters: FilterDefinition = defaultFilterDefinition();

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function paginationFrom(raw: Record<string, unknown> | undefined, fallbackTotal: number): PaginationMeta {
  return {
    currentPage: Number(raw?.current_page ?? raw?.page ?? 1),
    lastPage: Number(raw?.last_page ?? raw?.lastPage ?? 1),
    total: Number(raw?.total ?? fallbackTotal),
  };
}

function absoluteComixUrl(url: string): string {
  if (!url) return '';
  return url.startsWith('http') ? url : `${BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

function titleList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') return firstString((item as Record<string, unknown>).title, (item as Record<string, unknown>).name);
      return '';
    })
    .filter(Boolean);
}

function detailTags(result: Record<string, unknown>, key: string): string[] {
  return titleList(result[key]);
}

function parseMangaItem(item: Record<string, unknown>): Manga {
  const poster = item.poster as Record<string, string> | null;
  const hashId = firstString(item.hash_id, item.hid);
  const slug = firstString(item.slug);
  const termIds = item.term_ids as number[] | undefined;
  const termMap = new Map<number, string>();
  for (const t of TERMS) termMap.set(t.id, t.name);
  const tags = termIds?.map(id => termMap.get(id)).filter((n): n is string => n != null);
  return {
    id: hashId || slug,
    title: String(item.title ?? ''),
    cover: poster?.medium ?? poster?.large ?? poster?.small ?? '',
    latestChapter: item.latest_chapter != null || item.latestChapter != null ? Number(item.latest_chapter ?? item.latestChapter) : null,
    author: item.author ? String(item.author) : undefined,
    status: item.status ? String(item.status) : undefined,
    tags: tags?.length ? tags : undefined,
  };
}

const provider: MangaProvider = {
  id: 'comix',
  name: 'Comix',
  baseUrl: BASE_URL,
  language: 'en',
  version: '1.0.0',
  nsfw: true,
  chapterImagesResponseType: 'json',

  getFilters(): FilterDefinition {
    return activeFilters;
  },

  setFilters(filters: FilterDefinition): void {
    activeFilters = filters;
  },

  searchRequest(query: string, page: number, filters?: SearchFilters): HttpRequest {
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('limit', String(SEARCH_LIMIT));
    if (query) {
      params.set('keyword', query);
    } else {
      params.set('order[chapter_updated_at]', 'desc');
    }

    if (filters) {
      if (filters.includeGenres) {
        for (const id of filters.includeGenres) params.append('genres_in[]', id);
      }
      if (filters.excludeGenres) {
        for (const id of filters.excludeGenres) params.append('genres_ex[]', id);
      }
      if ((filters.includeGenres?.length ?? 0) > 0 || (filters.excludeGenres?.length ?? 0) > 0) {
        params.set('genres_mode', 'and');
      }
      if (filters.demographics) {
        for (const id of filters.demographics) params.append('demographics[]', id);
      }
      if (filters.authors) {
        for (const id of filters.authors) params.append('authors[]', id);
      }
      if (filters.artists) {
        for (const id of filters.artists) params.append('artists[]', id);
      }
      if (filters.types) {
        for (const t of filters.types) params.append('types[]', t);
      }
      if (filters.statuses) {
        for (const s of filters.statuses) params.append('statuses[]', s);
      }
    }

    return { url: `${API_URL}/manga?${params}`, cloudflareProtected: true };
  },

  parseSearchResponse(data: unknown): PagedResult<Manga> {
    const d = data as Record<string, unknown>;
    const result = d.result as Record<string, unknown> | undefined;
    const items = (result?.items ?? (d as Record<string, unknown>).items ?? []) as Record<string, unknown>[];
    const paginationRaw = (result?.pagination ?? result?.meta ?? d.pagination ?? d.meta) as Record<string, unknown> | undefined;

    const manga: Manga[] = items.map(item => parseMangaItem(item));

    const pagination = paginationRaw ? paginationFrom(paginationRaw, items.length) : undefined;

    return { items: manga, hasMore: pagination ? pagination.currentPage < pagination.lastPage : manga.length >= SEARCH_LIMIT, pagination };
  },

  parseMangaDetailResponse(data: unknown): Partial<Manga> {
    const d = data as Record<string, unknown>;
    const result = (d.result ?? d) as Record<string, unknown>;
    const poster = result.poster as Record<string, string> | null;
    const genres = detailTags(result, 'genres');
    const tags = detailTags(result, 'tags');
    const demographics = detailTags(result, 'demographics');
    const authors = detailTags(result, 'authors');
    const artists = detailTags(result, 'artists');
    const altTitles = titleList(result.altTitles ?? result.alt_titles);
    const authorList = [...authors, ...artists.filter(name => !authors.includes(name))];
    const recommendationsRaw = Array.isArray(result.recommendations) ? result.recommendations as Record<string, unknown>[] : [];
    const recommendations = recommendationsRaw.map(item => parseMangaItem(item));

    return {
      id: firstString(result.hid, result.hash_id, result.id),
      title: String(result.title ?? ''),
      cover: poster?.large ?? poster?.medium ?? poster?.small ?? '',
      latestChapter: result.latestChapter != null || result.latest_chapter != null ? Number(result.latestChapter ?? result.latest_chapter) : null,
      status: result.status ? String(result.status) : undefined,
      author: authorList.length > 0 ? authorList.join(', ') : undefined,
      altTitles: altTitles.length > 0 ? altTitles : undefined,
      description: firstString(result.synopsis, result.description),
      genres: genres.length > 0 ? genres : undefined,
      tags: tags.length > 0 ? tags : undefined,
      demographics: demographics.length > 0 ? demographics : undefined,
      authors: authorList.length > 0 ? authorList : undefined,
      recommendations: recommendations.length > 0 ? recommendations : undefined,
    };
  },

  chapterListRequest(mangaId: string, page: number): HttpRequest {
    const params = new URLSearchParams();
    params.set('limit', '20');
    params.set('page', String(page));
    params.set('order[number]', 'desc');
    return { url: `${API_URL}/manga/${mangaId}/chapters?${params}`, cloudflareProtected: true };
  },

  parseChapterListResponse(data: unknown): ChapterListPage {
    const d = data as Record<string, unknown>;
    const result = d.result as Record<string, unknown> | undefined;
    const items = (result?.items ?? []) as Record<string, unknown>[];
    const paginationRaw = (result?.pagination ?? result?.meta ?? d.pagination ?? d.meta) as Record<string, unknown> | undefined;

    const chapters = items.map(item => {
      const group = (item.scanlation_group ?? item.group) as Record<string, unknown> | undefined;
      return {
        id: firstString(item.chapter_id, item.id),
        number: parseFloat(String(item.number)),
        groupId: firstString(item.scanlation_group_id, group?.id) || undefined,
        groupName: (group?.name as string) ?? 'Unknown',
        uploadedAt: item.created_at != null ? Number(item.created_at) : undefined,
        url: absoluteComixUrl(firstString(item.url)),
      };
    });

    const pagination = paginationFrom(paginationRaw, items.length);

    return { items: chapters, pagination };
  },

  chapterImagesRequest(mangaId: string, chapterId: string, chapterNumber: number, chapterUrl?: string): HttpRequest {
    return {
      url: `${API_URL}/chapters/${chapterId}`,
      cloudflareProtected: true,
    };
  },

  parseChapterImagesResponse(data: unknown): ChapterPage[] {
    const d = data as Record<string, unknown>;
    const result = d.result as Record<string, unknown> | undefined;
    const parsed = (result?.pages ?? []) as { url: string; width?: number; height?: number }[];
    return parsed.map(img => ({
      url: String(img.url ?? ''),
      width: Number(img.width ?? 0),
      height: Number(img.height ?? 0),
    }));
  },

  imageHeaders(mangaId: string, chapterId: string, chapterNumber: number, chapterUrl?: string): Record<string, string> {
    return { Referer: absoluteComixUrl(chapterUrl ?? '') || `${BASE_URL}/title/${mangaId}/${chapterId}-chapter-${chapterNumber}` };
  },
};

export default provider;
