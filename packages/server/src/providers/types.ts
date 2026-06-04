import type { Page } from 'playwright';
import type { FilterDefinition } from '@manga-reader/provider-types';

export interface RuntimeChapterImages {
  source: string;
  targetCount: number;
  schemaVersion: number;
  pages: Array<{ url: string; width: number; height: number; scramble: boolean }>;
}

export interface RuntimeByteResult {
  buffer: Buffer;
  contentType: string;
  status: number;
}

export interface ServerMangaProvider {
  readonly id: string;
  readonly name: string;
  readonly domain: string;
  readonly baseUrl: string;
  readonly runtimeImageSource: string;
  readonly imageDelivery: 'store-candidates' | 'direct';
  readonly searchPageSize: number;
  readonly commentsMode?: 'thread-api' | 'count-only' | 'page-document';
  readonly browserProfileDir?: string;
  readonly browserExecutablePath?: string;
  readonly browserInitTimeoutMs?: number;
  readonly runtimeProbeMangaId?: string;
  readonly runtimePageTimeoutMs?: number;

  resolveRuntimeHttpClient(page: Page, probeMangaId: string, owner: string): Promise<void>;
  runtimePageUrl(mangaId: string): string;
  mangaDetailPath(mangaId: string): string;
  mangaRecommendationsPath(mangaId: string): string;
  normalizeMangaDetail?(detail: Record<string, unknown>, recommendations: unknown[]): unknown;
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
  mangaCommentCountUrl?(numericMangaId: number, pageUrl: string): string | null;
  mangaCommentsUrl?(numericMangaId: number, pageUrl: string): string | null;
  chapterCommentCountUrl?(chapterId: string, chapterNumber: number, pageUrl: string): string | null;
  chapterCommentsUrl?(chapterId: string, chapterNumber: number, pageUrl: string): string | null;

  absoluteUrl(url: string): string;
  searchThumbnailReferer(): string;
  rawMangaUrlFromChapterItem(item: unknown, mangaId: string, chapterId: string, chapterNumber?: number): string;
  filterCatalogDocumentUrl?(): string;
  parseFilterCatalogDocument?(html: string): FilterDefinition;
  getFilterCatalog(): Promise<{ filters: FilterDefinition; source: 'cache' | 'upstream'; ageMs: number }>;
}
