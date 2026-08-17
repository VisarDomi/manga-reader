export const PROGRESS_KEY = 'manga-reader-progress-v1';

export interface ChapterProgress {
    id: string;
    provider: string;
    seriesSlug: string;
    chapterId: string;
    imageIndex: number;
    totalImages: number;
    updatedAt: number;
}

function isProgress(value: unknown): value is ChapterProgress {
    if (typeof value !== 'object' || value === null) return false;
    const item = value as Partial<ChapterProgress>;
    return typeof item.id === 'string'
        && typeof item.provider === 'string'
        && typeof item.seriesSlug === 'string'
        && typeof item.chapterId === 'string'
        && Number.isInteger(item.imageIndex)
        && Number.isInteger(item.totalImages)
        && typeof item.updatedAt === 'number'
        && Number.isFinite(item.updatedAt)
        && item.imageIndex! >= 0
        && item.totalImages! > item.imageIndex!;
}

function readProgress(): ChapterProgress[] {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (raw === null) return [];

    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) throw new Error('Stored chapter progress is not an array');
    if (!value.every(isProgress)) throw new Error('Stored chapter progress contains an invalid entry');
    return value;
}

function progressId(provider: string, seriesSlug: string, chapterId: string): string {
    return `${provider}\u0000${seriesSlug}\u0000${chapterId}`;
}

export function isChapterComplete(progress: ChapterProgress): boolean {
    return progress.totalImages > 0 && progress.imageIndex >= progress.totalImages - 1;
}

export function saveChapterProgress(
    provider: string,
    seriesSlug: string,
    chapterId: string,
    imageIndex: number,
    totalImages: number,
): ChapterProgress {
    if (!Number.isInteger(imageIndex) || imageIndex < 0) throw new Error('Cannot save an invalid page index');
    if (!Number.isInteger(totalImages) || totalImages <= 0 || imageIndex >= totalImages) {
        throw new Error('Cannot save progress outside the chapter page range');
    }

    const progress: ChapterProgress = {
        id: progressId(provider, seriesSlug, chapterId),
        provider,
        seriesSlug,
        chapterId,
        imageIndex,
        totalImages,
        updatedAt: Date.now(),
    };
    const next = readProgress().filter(item => item.id !== progress.id);
    next.push(progress);
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(next));
    return progress;
}

export function getProviderProgress(provider: string): ChapterProgress[] {
    return readProgress().filter(item => item.provider === provider);
}
