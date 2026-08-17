// Worker-safe valir remote history + tracking builders (were in valir.ts).
import type { ChapterData, ChapterMeta, RemoteSeriesHistory } from './types';

function record(value: unknown, context: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`Valir ${context} is not an object`);
    }
    return value as Record<string, unknown>;
}

function requiredString(value: unknown, context: string): string {
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`Valir ${context} is not a string`);
    return value;
}

function positiveChapter(value: unknown, context: string): string {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new Error(`Valir ${context} is not a positive chapter number`);
    }
    return String(value);
}

export interface ValirReadingPosition {
    seriesId: string | number;
    chapters: Array<{ chapterId: string | number; progress: number }>;
}

export function buildValirReadingPosition(
    data: ChapterData,
    imageIndex: string,
    chaptersNewestFirst: ChapterMeta[],
): ValirReadingPosition | null {
    if (!data.seriesApiId || !data.chapterApiId) return null;

    const parsedImageIndex = parseInt(imageIndex, 10);
    const totalImages = data.images.length;
    const progress = Math.round((parsedImageIndex + 1) / totalImages * 100);

    const chapters: Array<{ chapterId: string | number; progress: number }> = [
        { chapterId: data.chapterApiId, progress },
    ];
    const currentIdx = chaptersNewestFirst.findIndex(chapter => chapter.chapterId === data.chapterId);
    if (currentIdx !== -1) {
        for (const chapter of chaptersNewestFirst.slice(currentIdx + 1)) {
            if (chapter.chapterApiId) chapters.push({ chapterId: chapter.chapterApiId, progress: 100 });
        }
    }
    return { seriesId: data.seriesApiId, chapters };
}

export function parseValirRemoteHistory(value: unknown): RemoteSeriesHistory[] {
    const envelope = record(value, 'continue reading response');
    if (!Array.isArray(envelope.series)) throw new Error('Valir continue reading response has no series array');
    return envelope.series.map((raw, index) => {
        const series = record(raw, `continue reading series ${index}`);
        const slug = requiredString(series.urlSlug ?? series.slug, `continue reading series ${index} slug`);
        const lastChapter = record(series.lastChapter, `continue reading series ${index} lastChapter`);
        const resumeChapterId = positiveChapter(
            lastChapter.number,
            `continue reading series ${index} lastChapter.number`,
        );
        const readThroughChapterId = positiveChapter(
            series.highestChapter,
            `continue reading series ${index} highestChapter`,
        );
        const history: RemoteSeriesHistory = { seriesId: slug, readThroughChapterId, resumeChapterId };
        if (lastChapter.progress !== undefined && lastChapter.progress !== null) {
            if (
                typeof lastChapter.progress !== 'number'
                || !Number.isFinite(lastChapter.progress)
                || lastChapter.progress < 0
                || lastChapter.progress > 100
            ) {
                throw new Error(`Valir continue reading series ${index} lastChapter.progress is invalid`);
            }
            history.resumePercent = lastChapter.progress;
        }
        return history;
    });
}
