import type { Provider } from './types';

/** Shared implementation of lastReadImageIndex for providers whose chapter
 * data comes from fetchChapter: the last page is images.length - 1.
 * Providers with different data sources implement their own instead. */
export function lastImageIndexFrom(
    fetchChapter: (slug: string, chapterId: string) => Promise<{ images: unknown[] } | null>,
): NonNullable<Provider['lastReadImageIndex']> {
    return async (slug, chapterId) => {
        const data = await fetchChapter(slug, chapterId);
        if (data === null || data.images.length === 0) return undefined;
        return String(data.images.length - 1);
    };
}

/** Shared implementation of resumeImageIndex: the default interpretation of a
 * server percentage is a page fraction, clamped to the chapter's page range. */
export function percentImageIndexFrom(
    fetchChapter: (slug: string, chapterId: string) => Promise<{ images: unknown[] } | null>,
): NonNullable<Provider['resumeImageIndex']> {
    return async (slug, chapterId, percent) => {
        const data = await fetchChapter(slug, chapterId);
        if (data === null || data.images.length === 0) return undefined;
        const total = data.images.length;
        return String(Math.max(0, Math.min(total - 1, Math.round(percent / 100 * total) - 1)));
    };
}
