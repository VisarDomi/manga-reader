# Domain Types

Tests assert business rules. If a test fails, the code is wrong — not the test.
The only exception is when a business rule changes.

---

## Domain Types (from packages/provider-types)

These are the spec-level types. Contracts reference these directly.

```typescript
interface Manga {
  id: string; title: string; cover: string;
  latestChapter: number | null;
  author?: string; status?: string; tags?: string[];
}

interface ChapterMeta {
  id: string; number: number;
  groupId?: string; groupName: string; uploadedAt?: number;
}

interface ChapterPage { url: string; width: number; height: number; }

interface SearchFilters {
  includeGenres?: string[]; excludeGenres?: string[];
  types?: string[]; statuses?: string[];
}

interface PagedResult<T> { items: T[]; hasMore: boolean; }

interface FilterOption { id: string; name: string; group?: string; nsfw?: boolean; }

interface FilterDefinition {
  genres: FilterOption[]; types?: FilterOption[]; statuses?: FilterOption[];
}

interface HttpRequest {
  url: string; method?: 'GET' | 'POST';
  headers?: Record<string, string>; body?: string;
  cloudflareProtected?: boolean;
}

interface MangaProvider {
  readonly id: string; readonly name: string;
  readonly baseUrl: string; readonly language: string;
  readonly version: string; readonly nsfw: boolean;

  getFilters(): FilterDefinition;

  searchRequest(query: string, page: number, filters?: SearchFilters): HttpRequest;
  parseSearchResponse(data: unknown): PagedResult<Manga>;

  chapterListRequest(mangaId: string, page: number): HttpRequest;
  parseChapterListResponse(data: unknown): ChapterMeta[];

  chapterImagesRequest(mangaId: string, chapterId: string, chapterNumber: number): HttpRequest;
  parseChapterImagesResponse(data: unknown): ChapterPage[];
  readonly chapterImagesResponseType: 'json' | 'html';

  imageHeaders?(): Record<string, string>;
}
```
