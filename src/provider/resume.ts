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
