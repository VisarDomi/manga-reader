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

/**
 * Collapse legacy per-chapter records to the last position visited in each
 * provider/series. This preserves intentional backscrolling during migration.
 */
export function normalizeProgress(entries: ChapterProgress[]): ChapterProgress[] {
    const byIdentity = new Map<string, ChapterProgress>();
    for (const entry of entries) {
        const id = progressId(entry.provider, entry.seriesSlug);
        const normalized = entry.id === id ? entry : { ...entry, id };
        const current = byIdentity.get(id);
        if (current === undefined || normalized.updatedAt >= current.updatedAt) {
            byIdentity.set(id, normalized);
        }
    }
    return [...byIdentity.values()];
}

export function progressNeedsNormalization(
    stored: ChapterProgress[],
    normalized: ChapterProgress[],
): boolean {
    if (stored.length !== normalized.length) return true;
    return stored.some(entry => entry.id !== progressId(entry.provider, entry.seriesSlug));
}

/** Indexed by provider-owned series identity within the current site origin. */
export function progressBySeries(entries: ChapterProgress[]): Map<string, ChapterProgress> {
    const result = new Map<string, ChapterProgress>();
    for (const entry of normalizeProgress(entries)) result.set(entry.seriesSlug, entry);
    return result;
}
