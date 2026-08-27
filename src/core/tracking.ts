import type { ChapterData, Provider } from '../provider';
import { computeRequest } from './compute/transport';

export interface ReaderTracker {
    track(data: ChapterData, imageIndex: string): void;
}

export interface LocalTrackingContext {
    seriesSlug: string;
    /** Provider-owned history identity; falls back to seriesSlug. */
    historyId?: string;
    onError(): void;
}

enum SyncState {
    Pending,
    Saved,
    Failed,
}

export function createReaderTracker(
    provider: Provider,
    local: LocalTrackingContext,
): ReaderTracker {
    const localPages = new Map<string, SyncState>();
    const providerChapters = new Map<string, SyncState>();

    return {
        track(data, imageIndex) {
            const pageKey = `${data.chapterId}:${imageIndex}`;
            if (!localPages.has(pageKey)) {
                localPages.set(pageKey, SyncState.Pending);
                void computeRequest('save-progress', {
                    provider: provider.key,
                    seriesSlug: local.historyId ?? local.seriesSlug,
                    chapterId: data.chapterId,
                    imageIndex: Number(imageIndex),
                    totalImages: data.images.length,
                }).then(
                    () => { localPages.set(pageKey, SyncState.Saved); },
                    () => {
                        localPages.set(pageKey, SyncState.Failed);
                        local.onError();
                    },
                );
            }

            if (
                provider.trackChapter
                && !providerChapters.has(data.chapterId)
            ) {
                providerChapters.set(data.chapterId, SyncState.Pending);
                void provider.trackChapter(data).then(
                    () => { providerChapters.set(data.chapterId, SyncState.Saved); },
                    () => {
                        providerChapters.set(data.chapterId, SyncState.Failed);
                        local.onError();
                    },
                );
            }
        },
    };
}
