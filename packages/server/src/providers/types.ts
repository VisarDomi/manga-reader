import type { Page } from 'playwright';
import type { FilterDefinition } from '@manga-reader/provider-types';

export interface RuntimeChapterImages {
  source: string;
  targetCount: number;
  schemaVersion: number;
  pages: Array<{ url: string; width: number; height: number; scramble: boolean }>;
}

export interface ServerMangaProvider {
  readonly id: string;
  readonly name: string;
  readonly domain: string;
  readonly baseUrl: string;
  readonly runtimeImageSource: string;

  resolveRuntimeHttpClient(page: Page, probeMangaId: string, owner: string): Promise<void>;
  runtimePageUrl(mangaId: string): string;
  mangaDetailPath(mangaId: string): string;
  mangaRecommendationsPath(mangaId: string): string;
  chapterListPath(mangaId: string): string;
  chapterListParams(page: number, pageSize: number): Record<string, unknown>;
  chapterImagesPath(chapterId: string): string;
  normalizeChapterImages(detail: Record<string, unknown>): RuntimeChapterImages;
  newestSearchUrl(page: number, limit: number): string;

  mangaPageUrl(mangaId: string, rawUrl?: unknown): string;
  chapterPageUrl(mangaId: string, chapterId: string, chapterNumber: number, rawUrl?: unknown): string;
  commentsLookupUrl(pageIdentifier: string, pageUrl: string): string;
  commentsPageUrl(threadId: number): string;
  commentTreeUrl(commentId: number): string;
  mangaCommentIdentifier(numericMangaId: number): string;
  chapterCommentIdentifier(numericMangaId: number, chapterNumber: number): string;

  absoluteUrl(url: string): string;
  searchThumbnailReferer(): string;
  rawMangaUrlFromChapterItem(item: unknown, mangaId: string, chapterId: string, chapterNumber?: number): string;
  getFilterCatalog(): Promise<{ filters: FilterDefinition; source: 'cache' | 'upstream'; ageMs: number }>;
  filterSearchUrl(type: string, keyword: string): string | null;
}
