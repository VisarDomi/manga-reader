import type { ChapterData, Provider } from '../provider';
import { ComputeWorkerResetError, computeRequest } from './compute/transport';

export interface ReaderTracker {
    track(data: ChapterData, imageIndex: string): void;
}

export interface LocalTrackingContext {
    seriesSlug: string;
    /** Provider-owned history identity; falls back to seriesSlug. */
    historyId?: string;
    onError(): void;
}

type SyncState = 'pending' | 'saved' | 'failed';

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
                localPages.set(pageKey, 'pending');
                void computeRequest('save-progress', {
                    provider: provider.key,
                    seriesSlug: local.historyId ?? local.seriesSlug,
                    chapterId: data.chapterId,
                    imageIndex: Number(imageIndex),
                    totalImages: data.images.length,
                }).then(
                    () => { localPages.set(pageKey, 'saved'); },
                    error => {
                        if (error instanceof ComputeWorkerResetError) {
                            localPages.delete(pageKey);
                            return;
                        }
                        localPages.set(pageKey, 'failed');
                        local.onError();
                    },
                );
            }

            if (
                provider.trackChapter
                && !providerChapters.has(data.chapterId)
            ) {
                providerChapters.set(data.chapterId, 'pending');
                void provider.trackChapter(data).then(
                    () => { providerChapters.set(data.chapterId, 'saved'); },
                    error => {
                        if (error instanceof ComputeWorkerResetError) {
                            providerChapters.delete(data.chapterId);
                            return;
                        }
                        providerChapters.set(data.chapterId, 'failed');
                        local.onError();
                    },
                );
            }
        },
    };
}
