// Pure, worker-safe local resume-position logic. Persistence lives in the
// worker's IndexedDB layer; the main thread only ships raw page positions.

export interface ChapterProgress {
    id: string;
    provider: string;
    seriesSlug: string;
    chapterId: string;
    imageIndex: number;
    totalImages: number;
    updatedAt: number;
}

/** One durable identity per provider and series; chapter/page are its value. */
export function progressId(provider: string, seriesSlug: string): string {
    return `${provider}\u0000${seriesSlug}`;
}

export function isChapterComplete(progress: ChapterProgress): boolean {
    return progress.totalImages > 0 && progress.imageIndex >= progress.totalImages - 1;
}

export function createChapterProgress(
    provider: string,
    seriesSlug: string,
    chapterId: string,
    imageIndex: number,
    totalImages: number,
    updatedAt: number = Date.now(),
): ChapterProgress {
    if (!Number.isInteger(imageIndex) || imageIndex < 0) throw new Error('Cannot save an invalid page index');
    if (!Number.isInteger(totalImages) || totalImages <= 0 || imageIndex >= totalImages) {
        throw new Error('Cannot save progress outside the chapter page range');
    }
    return {
        id: progressId(provider, seriesSlug),
        provider,
        seriesSlug,
        chapterId,
        imageIndex,
        totalImages,
        updatedAt,
    };
}

/** Indexed by provider-owned series identity within the current site origin. */
export function progressBySeries(entries: ChapterProgress[]): Map<string, ChapterProgress> {
    const result = new Map<string, ChapterProgress>();
    for (const entry of entries) result.set(entry.seriesSlug, entry);
    return result;
}
