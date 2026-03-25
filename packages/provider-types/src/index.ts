// Shared data types used by providers and the app

export interface Manga {
  id: string;
  title: string;
  cover: string;
  latestChapter: number | null;
  author?: string;
  status?: string;
  tags?: string[];
}

export interface ChapterMeta {
  id: string;
  number: number;
  groupId?: string;
  groupName: string;
  uploadedAt?: number;
}

export interface ChapterPage {
  url: string;
  width: number;
  height: number;
}

export interface SearchFilters {
  includeGenres?: string[];
  excludeGenres?: string[];
  types?: string[];
  statuses?: string[];
}

export interface PaginationMeta {
  currentPage: number;
  lastPage: number;
  total: number;
}

export interface PagedResult<T> {
  items: T[];
  hasMore: boolean;
  pagination?: PaginationMeta;
}

export interface ChapterListPage {
  items: ChapterMeta[];
  pagination: PaginationMeta;
}

export interface FilterOption {
  id: string;
  name: string;
  group?: string;
  nsfw?: boolean;
}

export interface FilterDefinition {
  genres: FilterOption[];
  types?: FilterOption[];
  statuses?: FilterOption[];
}

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  cloudflareProtected?: boolean;
}

// The interface each provider implements
export interface MangaProvider {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly language: string;
  readonly version: string;
  readonly nsfw: boolean;

  getFilters(): FilterDefinition;

  searchRequest(query: string, page: number, filters?: SearchFilters): HttpRequest;
  parseSearchResponse(data: unknown): PagedResult<Manga>;

  chapterListRequest(mangaId: string, page: number): HttpRequest;
  parseChapterListResponse(data: unknown): ChapterListPage;

  chapterImagesRequest(mangaId: string, chapterId: string, chapterNumber: number): HttpRequest;
  parseChapterImagesResponse(data: unknown): ChapterPage[];
  readonly chapterImagesResponseType: 'json' | 'html';

  imageHeaders?(mangaId: string, chapterId: string, chapterNumber: number): Record<string, string>;
}
