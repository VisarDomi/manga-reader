import type { ChapterData } from '../provider';
import { computeRequest } from './compute/transport';

export interface ReaderTracker {
    track(data: ChapterData, imageIndex: string): void;
}

export interface LocalTrackingContext {
    providerKey: string;
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
                    provider: local.providerKey,
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
                local
                && local.providerKey === 'asurascans'
                && !trackedChapters.has(data.chapterId)
            ) {
                trackedChapters.add(data.chapterId);
                void computeRequest('track-chapter', {
                    provider: local.providerKey,
                    data,
                }).catch(error => reportSidecarError(local, error));
            }
        },
    };
}
