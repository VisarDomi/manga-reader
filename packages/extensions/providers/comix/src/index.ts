import type { MangaProvider, Manga, ChapterMeta, ChapterPage, SearchFilters, PagedResult, FilterDefinition, HttpRequest } from '@manga-reader/provider-types';
import { TERMS, TYPES, STATUSES, TYPE_LABELS, STATUS_LABELS, NSFW_TERM_IDS } from './terms.js';
import { extractJsonArray } from './parse.js';

const BASE_URL = 'https://comix.to';
const API_URL = `${BASE_URL}/api/v2`;
const SEARCH_LIMIT = 100;

const provider: MangaProvider = {
  id: 'comix',
  name: 'Comix',
  baseUrl: BASE_URL,
  language: 'en',
  version: '1.0.0',
  nsfw: true,
  chapterImagesResponseType: 'html',

  getFilters(): FilterDefinition {
    const nsfwIds = new Set(NSFW_TERM_IDS.map(Number));
    const genres = TERMS.map(t => ({
      id: String(t.id),
      name: t.name,
      group: t.category,
      ...(nsfwIds.has(t.id) ? { nsfw: true as const } : {}),
    }));
    const types = TYPES.map(t => ({
      id: t,
      name: TYPE_LABELS[t] ?? t,
    }));
    const statuses = STATUSES.map(s => ({
      id: s,
      name: STATUS_LABELS[s] ?? s,
    }));
    return { genres, types, statuses };
  },

  // --- Search ---

  searchRequest(query: string, page: number, filters?: SearchFilters): HttpRequest {
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('limit', String(SEARCH_LIMIT));
    if (query) {
      params.set('keyword', query);
    } else if (!filters) {
      params.set('order[chapter_updated_at]', 'desc');
    }

    if (filters) {
      if (filters.includeGenres) {
        for (const id of filters.includeGenres) params.append('genres[]', id);
      }
      if (filters.excludeGenres) {
        for (const id of filters.excludeGenres) params.append('genres[]', `-${id}`);
      }
      if ((filters.includeGenres?.length ?? 0) > 0 || (filters.excludeGenres?.length ?? 0) > 0) {
        params.set('genres_mode', 'and');
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

    const termMap = new Map<number, string>();
    for (const t of TERMS) termMap.set(t.id, t.name);

    const manga: Manga[] = items.map(item => {
      const poster = item.poster as Record<string, string> | null;
      const hashId = String(item.hash_id ?? '');
      const slug = String(item.slug ?? '');
      const termIds = item.term_ids as number[] | undefined;
      const tags = termIds?.map(id => termMap.get(id)).filter((n): n is string => n != null);
      return {
        id: hashId || slug,
        title: String(item.title ?? ''),
        cover: poster?.medium ?? poster?.large ?? poster?.small ?? '',
        latestChapter: item.latest_chapter != null ? Number(item.latest_chapter) : null,
        author: item.author ? String(item.author) : undefined,
        status: item.status ? String(item.status) : undefined,
        tags: tags?.length ? tags : undefined,
      };
    });

    return { items: manga, hasMore: manga.length >= SEARCH_LIMIT };
  },

  // --- Chapters ---

  chapterListRequest(mangaId: string, page: number): HttpRequest {
    const params = new URLSearchParams();
    params.set('limit', '100');
    params.set('page', String(page));
    params.set('order[number]', 'desc');
    return { url: `${API_URL}/manga/${mangaId}/chapters?${params}`, cloudflareProtected: true };
  },

  parseChapterListResponse(data: unknown): ChapterMeta[] {
    const d = data as Record<string, unknown>;
    const result = d.result as Record<string, unknown> | undefined;
    const items = (result?.items ?? []) as Record<string, unknown>[];

    return items.map(item => {
      const group = item.scanlation_group as Record<string, unknown> | undefined;
      return {
        id: String(item.chapter_id ?? ''),
        number: parseFloat(String(item.number)),
        groupId: item.scanlation_group_id != null ? String(item.scanlation_group_id) : undefined,
        groupName: (group?.name as string) ?? 'Unknown',
        uploadedAt: item.created_at != null ? Number(item.created_at) : undefined,
      };
    });
  },

  // --- Chapter Images ---

  chapterImagesRequest(mangaId: string, chapterId: string, chapterNumber: number): HttpRequest {
    return { url: `${BASE_URL}/title/${mangaId}/${chapterId}-chapter-${chapterNumber}`, cloudflareProtected: true };
  },

  parseChapterImagesResponse(data: unknown): ChapterPage[] {
    const html = data as string;
    const jsonString = extractJsonArray(html, 'images');
    const parsed = JSON.parse(jsonString) as { url: string; width?: number; height?: number }[];
    return parsed.map(img => ({
      url: String(img.url ?? ''),
      width: Number(img.width ?? 0),
      height: Number(img.height ?? 0),
    }));
  },

  imageHeaders(): Record<string, string> {
    return { Referer: BASE_URL };
  },
};

export default provider;
