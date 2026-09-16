import type { ChapterData, Provider } from '../provider';
import { computeRequest } from './compute/transport';

interface ReaderTracker {
    track(data: ChapterData, imageIndex: string): void;
}

interface LocalTrackingContext {
    seriesSlug: string;
    /** Provider-owned history identity; falls back to seriesSlug. */
    historyId?: string;
    onError(): void;
}

export function createReaderTracker(
    provider: Provider,
    local: LocalTrackingContext,
): ReaderTracker {
    let localPageKey: string | undefined;

    return {
        track(data, imageIndex) {
            const pageKey = `${data.chapterId}:${imageIndex}`;
            if (localPageKey !== pageKey) {
                localPageKey = pageKey;
                void computeRequest('save-progress', {
                    provider: provider.key,
                    seriesSlug: local.historyId ?? local.seriesSlug,
                    chapterId: data.chapterId,
                    imageIndex: Number(imageIndex),
                    totalImages: data.images.length,
                }).catch(() => local.onError());
            }
        },
    };
}
