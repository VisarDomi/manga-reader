import type {
  ChapterListPage,
  ChapterMeta,
  ChapterPage,
  FilterDefinition,
  HttpRequest,
  Manga,
  MangaProvider,
  PagedResult,
  SearchFilters,
} from '@manga-reader/provider-types';

const BASE_URL = 'https://mangataro.org';

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

function parseMangaItem(raw: Record<string, unknown>): Manga {
  const id = firstString(raw.id);
  // Handle WP REST format: title.rendered, link, slug
  const titleRendered = (raw.title as Record<string, unknown>)?.rendered;
  const title = firstString(titleRendered, raw.title);
  const cover = absoluteUrl(firstString(raw.cover));
  const status = firstString(raw.status) || undefined;
  const type = firstString(raw.type) || undefined;
  // Extract type from class_list (WP REST format)
  const classList = Array.isArray(raw.class_list) ? raw.class_list as string[] : [];
  const genreTags = classList
    .filter(c => c.startsWith('tag-'))
    .map(c => c.replace('tag-', ''));
  const tags = type ? [type, ...genreTags].filter(Boolean) : genreTags.length > 0 ? genreTags : undefined;

  return {
    id,
    title,
    cover,
    latestChapter: null,
    author: undefined,
    status,
    tags: tags && tags.length > 0 ? tags : undefined,
  };
}

const defaultFilters: FilterDefinition = {
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
};

let activeFilters: FilterDefinition = defaultFilters;

const provider: MangaProvider = {
  id: 'mangataro',
  name: 'MangaTaro',
  baseUrl: BASE_URL,
  language: 'en',
  version: '1.0.0',
  nsfw: false,
  chapterImagesResponseType: 'html',

  getFilters(): FilterDefinition {
    return activeFilters;
  },

  setFilters(filters: FilterDefinition): void {
    activeFilters = filters;
  },

  searchRequest(query: string, page: number, _filters?: SearchFilters): HttpRequest {
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('post_type', 'manga');
    if (query) params.set('s', query);
    return {
      url: `${BASE_URL}/wp-json/manga/v1/load`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    };
  },

  parseSearchResponse(data: unknown): PagedResult<Manga> {
    const items = Array.isArray(data) ? data : [];
    const manga = items
      .filter((item): item is Record<string, unknown> => item != null && typeof item === 'object' && !Array.isArray(item))
      .map(parseMangaItem);

    return {
      items: manga,
      hasMore: manga.length >= 24,
      pagination: {
        currentPage: 1,
        lastPage: 1,
        total: manga.length,
      },
    };
  },

  parseMangaDetailResponse(data: unknown): Partial<Manga> {
    const html = typeof data === 'string' ? data : String(data ?? '');
    const title = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"/)?.[1]
      ?? html.match(/<meta[^>]*name="title"[^>]*content="([^"]*)"/)?.[1]
      ?? '';

    const description = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]*)"/)?.[1]
      ?? html.match(/<meta[^>]*name="description"[^>]*content="([^"]*)"/)?.[1]
      ?? '';

    const cover = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]*)"/)?.[1] ?? '';
    const id = html.match(/data-manga-id="(\d+)"/)?.[1] ?? '';

    const status = html.match(/class="text-xs[^"]*capitalize"[^>]*>([^<]*)<\/span>/)?.[1]
      ?.trim() ?? undefined;

    const type = html.match(/class="text-xs[^"]*capitalize"[^>]*>([^<]*)<\/span>/)?.[1]
      ?.trim() ?? undefined;

    return {
      id,
      title,
      description: description || undefined,
      cover: absoluteUrl(cover),
      status,
      tags: type ? [type] : undefined,
    };
  },

  chapterListRequest(mangaId: string, _page: number): HttpRequest {
    return { url: `${BASE_URL}/auth/manga-chapters?manga_id=${encodeURIComponent(mangaId)}&offset=0&limit=500&order=DESC` };
  },

  parseChapterListResponse(data: unknown): ChapterListPage {
    const root = (data as Record<string, unknown>) ?? {};
    // Handle both raw API format { chapters: [...] } and server-enveloped { result: { items: [...] } }
    const rawItems = Array.isArray(root.chapters)
      ? root.chapters
      : Array.isArray((root.result as Record<string, unknown>)?.items)
        ? (root.result as Record<string, unknown>).items as Record<string, unknown>[]
        : [];
    const chapters: ChapterMeta[] = rawItems
      .filter((item): item is Record<string, unknown> => item != null && typeof item === 'object' && !Array.isArray(item))
      .map(item => {
        const rawId = firstString(item.id);
        const number = parseFloat(String(item.chapter ?? item.number ?? '0'));
        const url = firstString(item.url);
        const groupName = firstString(item.group_name) || 'Unknown';
        const uploadedAt = numeric(item.date_added ?? item.uploadedAt);
        // Use existing compound id if already in slug:num:id format
        const id = rawId && rawId.split(':').length >= 3 ? rawId : (() => {
          const slug = url.replace(/https?:\/\/[^\/]+\/read\//, '').replace(/\/ch\d+-.*$/, '');
          return slug && number ? `${slug}:${number}:${rawId}` : rawId;
        })();
        return {
          id,
          number,
          groupId: firstString(item.group_id) || undefined,
          groupName,
          uploadedAt: uploadedAt ?? undefined,
          url,
        };
      });

    return {
      items: chapters,
      pagination: {
        currentPage: 1,
        lastPage: 1,
        total: chapters.length,
      },
    };
  },

  chapterImagesRequest(_mangaId: string, chapterId: string, _chapterNumber: number, _chapterUrl?: string): HttpRequest {
    // chapterId is compound "slug:num:id" or full URL
    if (chapterId.startsWith('http')) return { url: chapterId };
    const parts = chapterId.split(':');
    if (parts.length === 3) {
      const [slug, num, id] = parts;
      return { url: `${BASE_URL}/read/${slug}/ch${num}-${id}` };
    }
    return { url: `${BASE_URL}/read/${chapterId}` };
  },

  parseChapterImagesResponse(data: unknown): ChapterPage[] {
    const html = typeof data === 'string' ? data : String(data ?? '');
    const urls = new Set<string>();
    const pattern = /https:\/\/mangataro\.yachts\/storage\/chapters\/[a-f0-9]+\/\d+\.webp/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      urls.add(match[0]);
    }
    return Array.from(urls).map(url => ({
      url,
      candidates: [url],
      criticalCandidates: [url],
      width: 0,
      height: 0,
      scramble: false,
    }));
  },

  imageHeaders(_mangaId: string, _chapterId: string, _chapterNumber: number, _chapterUrl?: string): Record<string, string> {
    return { Referer: BASE_URL };
  },
};

export default provider;
