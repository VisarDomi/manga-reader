import type { ChapterData, ChapterMeta, Provider } from '../provider';

type TrackingProvider = Pick<Provider, 'trackPage' | 'trackChapter'>;

export interface ReaderTracker {
    track(data: ChapterData, imageIndex: string, chaptersNewestFirst: ChapterMeta[]): void;
}

export function createReaderTracker(provider: TrackingProvider): ReaderTracker {
    const trackedPages = new Set<string>();
    const trackedChapters = new Set<string>();

    return {
        track(data, imageIndex, chaptersNewestFirst) {
            const pageKey = `${data.chapterId}:${imageIndex}`;
            if (!trackedPages.has(pageKey)) {
                trackedPages.add(pageKey);
                void provider.trackPage?.(data, imageIndex, chaptersNewestFirst);
            }

            if (!trackedChapters.has(data.chapterId)) {
                trackedChapters.add(data.chapterId);
                void provider.trackChapter?.(data);
            }
        },
    };
}
