import type { ChapterData, Provider } from '../provider';
import { computeRequest } from './compute/transport';

export interface ReaderTracker {
    track(data: ChapterData, imageIndex: string): void;
}

export interface LocalTrackingContext {
    seriesSlug: string;
    /** Provider-owned history identity; falls back to seriesSlug. */
    historyId?: string;
    onError?(error: unknown): void;
}

function reportSidecarError(local: LocalTrackingContext | undefined, error: unknown): void {
    // The visible onError channel is the loud path; the console is only the
    // fallback when the caller never wired one.
    if (local?.onError) {
        local.onError(error);
        return;
    }
    console.error('Provider tracking sidecar failed', error);
}

export function createReaderTracker(
    provider: Provider,
    local?: LocalTrackingContext,
): ReaderTracker {
    const savedLocalPages = new Set<string>();
    const trackedChapters = new Set<string>();

    return {
        track(data, imageIndex) {
            const pageKey = `${data.chapterId}:${imageIndex}`;
            if (local && !savedLocalPages.has(pageKey)) {
                savedLocalPages.add(pageKey);
                void computeRequest('save-progress', {
                    provider: provider.key,
                    seriesSlug: local.historyId ?? local.seriesSlug,
                    chapterId: data.chapterId,
                    imageIndex: Number(imageIndex),
                    totalImages: data.images.length,
                }).catch(error => {
                    savedLocalPages.delete(pageKey);
                    local.onError?.(error);
                });
            }

            if (
                provider.trackChapter
                && !trackedChapters.has(data.chapterId)
            ) {
                trackedChapters.add(data.chapterId);
                void provider.trackChapter(data).catch(error => reportSidecarError(local, error));
            }
        },
    };
}
