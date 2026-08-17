// Pure, worker-safe progress-store logic. No DOM, no storage APIs here:
// persistence lives in the worker's IndexedDB layer; the main thread only ever
// ships raw data in and receives resolved models out.

export interface ChapterProgress {
    id: string;
    provider: string;
    seriesSlug: string;
    chapterId: string;
    imageIndex: number;
    totalImages: number;
    updatedAt: number;
}

export function progressId(provider: string, seriesSlug: string, chapterId: string): string {
    return `${provider}\u0000${seriesSlug}\u0000${chapterId}`;
}

export function progressKey(seriesSlug: string, chapterId: string): string {
    return `${seriesSlug}\u0000${chapterId}`;
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
        id: progressId(provider, seriesSlug, chapterId),
        provider,
        seriesSlug,
        chapterId,
        imageIndex,
        totalImages,
        updatedAt,
    };
}

export function newestPartial(progress: ChapterProgress[]): ChapterProgress | undefined {
    return progress
        .filter(item => !isChapterComplete(item))
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

export interface ProgressIndex {
    byChapter: Map<string, ChapterProgress>;
    bySeries: Map<string, ChapterProgress[]>;
}

export function buildProgressIndex(entries: ChapterProgress[]): ProgressIndex {
    const byChapter = new Map<string, ChapterProgress>();
    const bySeries = new Map<string, ChapterProgress[]>();
    for (const entry of entries) {
        byChapter.set(progressKey(entry.seriesSlug, entry.chapterId), entry);
        const series = bySeries.get(entry.seriesSlug);
        if (series === undefined) bySeries.set(entry.seriesSlug, [entry]);
        else series.push(entry);
    }
    return { byChapter, bySeries };
}
