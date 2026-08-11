import type { ChapterData, ChapterMeta, Provider } from '../provider';
import { saveChapterProgress } from '../storage/progress';

type TrackingProvider = Pick<Provider, 'trackPage' | 'trackChapter'>;

export interface ReaderTracker {
    track(data: ChapterData, imageIndex: string, chaptersNewestFirst: ChapterMeta[]): void;
}

export interface LocalTrackingContext {
    providerKey: string;
    seriesSlug: string;
    onError?(error: unknown): void;
}

function reportSidecarError(error: unknown): void {
    console.error('Provider tracking sidecar failed', error);
}

export function createReaderTracker(
    provider: TrackingProvider,
    local?: LocalTrackingContext,
): ReaderTracker {
    const savedLocalPages = new Set<string>();
    const trackedProviderPages = new Set<string>();
    const trackedChapters = new Set<string>();

    return {
        track(data, imageIndex, chaptersNewestFirst) {
            const pageKey = `${data.chapterId}:${imageIndex}`;
            if (local && !savedLocalPages.has(pageKey)) {
                savedLocalPages.add(pageKey);
                try {
                    saveChapterProgress(
                        local.providerKey,
                        local.seriesSlug,
                        data.chapterId,
                        Number(imageIndex),
                        data.images.length,
                    );
                } catch (error) {
                    savedLocalPages.delete(pageKey);
                    local.onError?.(error);
                }
            }

            // Valir needs the complete chapter list to mark older chapters.
            // Keep this dedupe separate from the always-immediate local write.
            if (chaptersNewestFirst.length > 0 && !trackedProviderPages.has(pageKey)) {
                trackedProviderPages.add(pageKey);
                void provider.trackPage?.(data, imageIndex, chaptersNewestFirst).catch(reportSidecarError);
            }

            if (!trackedChapters.has(data.chapterId)) {
                trackedChapters.add(data.chapterId);
                void provider.trackChapter?.(data).catch(reportSidecarError);
            }
        },
    };
}
