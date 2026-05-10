export interface Manga {
  id: string;
  title: string;
  cover: string;
  latestChapter: number | null;
  author?: string;
  status?: string;
  tags?: string[];
  altTitles?: string[];
  description?: string;
  genres?: string[];
  demographics?: string[];
  authors?: string[];
  recommendations?: Manga[];
}

export interface ChapterMeta {
  id: string;
  number: number;
  groupId?: string;
  groupName: string;
  uploadedAt?: number;
  uploadedAtLabel?: string;
  url?: string;
}

export interface ChapterPage {
  url: string;
  width: number;
  height: number;
}

export interface SearchFilters {
  includeGenres?: string[];
  excludeGenres?: string[];
  demographics?: string[];
  authors?: string[];
  artists?: string[];
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
  demographics?: FilterOption[];
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

export interface MangaProvider {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly language: string;
  readonly version: string;
  readonly nsfw: boolean;

  getFilters(): FilterDefinition;
  setFilters?(filters: FilterDefinition): void;

  searchRequest(query: string, page: number, filters?: SearchFilters): HttpRequest;
  parseSearchResponse(data: unknown): PagedResult<Manga>;

  parseMangaDetailResponse?(data: unknown): Partial<Manga>;

  chapterListRequest(mangaId: string, page: number): HttpRequest;
  parseChapterListResponse(data: unknown): ChapterListPage;

  chapterImagesRequest(mangaId: string, chapterId: string, chapterNumber: number, chapterUrl?: string): HttpRequest;
  parseChapterImagesResponse(data: unknown): ChapterPage[];
  readonly chapterImagesResponseType: 'json' | 'html';

  imageHeaders?(mangaId: string, chapterId: string, chapterNumber: number, chapterUrl?: string): Record<string, string>;
}
