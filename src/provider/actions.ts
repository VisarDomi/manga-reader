import { computeRequest } from '../core/compute/transport';
import type {
    ChapterAppendRequest,
    ChapterAppendResult,
    ChapterData,
    ChapterLoader,
    ChapterLoadRequest,
    ChapterMeta,
    ChapterOpenRequest,
    ChapterOpenResult,
    HomeDestinationRequest,
    HomePage,
    RemoteSeriesHistory,
} from './types';

type RawChapterFetcher = (slug: string, chapterId: string) => Promise<ChapterData | null>;
type ChapterListFetcher = (slug: string) => Promise<ChapterMeta[]>;
type ReaderUrl = (slug: string, chapterId: string, imageIndex?: string) => string;
type SeriesUrl = (slug: string) => string;

export function chapterLoader(
    fetchChapter: RawChapterFetcher,
    seriesUrl: SeriesUrl,
): ChapterLoader {
    async function load(request: ChapterOpenRequest): Promise<ChapterOpenResult>;
    async function load(request: ChapterAppendRequest): Promise<ChapterAppendResult>;
    async function load(request: ChapterLoadRequest): Promise<ChapterOpenResult | ChapterAppendResult> {
        const data = await fetchChapter(request.slug, request.chapterId);
        if (data !== null) return { kind: 'chapter', data };
        return request.intent === 'open'
            ? { kind: 'navigate', url: seriesUrl(request.slug) }
            : { kind: 'stop' };
    }
    return load;
}

export function homeDestinationResolver(options: {
    fetchChapter: RawChapterFetcher;
    fetchChaptersNewestFirst: ChapterListFetcher;
    readerUrl: ReaderUrl;
    seriesUrl: SeriesUrl;
}): (request: HomeDestinationRequest) => Promise<string> {
    return async request => {
        if (request.kind === 'start') {
            const chapters = await options.fetchChaptersNewestFirst(request.seriesSlug);
            const first = chapters.at(-1);
            return first === undefined
                ? options.seriesUrl(request.seriesSlug)
                : options.readerUrl(request.seriesSlug, first.chapterId);
        }

        if (request.imageIndex !== undefined) {
            return options.readerUrl(request.seriesSlug, request.chapterId, request.imageIndex);
        }
        const data = await options.fetchChapter(request.seriesSlug, request.chapterId);
        if (data === null) return options.seriesUrl(request.seriesSlug);
        return options.readerUrl(
            request.seriesSlug,
            request.chapterId,
            String(data.images.length - 1),
        );
    };
}

export function workerHome(provider: string): (cursor: string | null) => Promise<HomePage> {
    return cursor => computeRequest('fetch-home', { provider, cursor });
}

export function workerRemoteHistory(provider: string): () => Promise<RemoteSeriesHistory[]> {
    return () => computeRequest('remote-history', { provider });
}

export function workerChapterTracker(provider: string): (data: ChapterData) => Promise<void> {
    return data => computeRequest('track-chapter', { provider, data });
}
