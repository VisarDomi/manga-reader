export type RouteMatch = {
    slug: string;
    chapterId: string;
    /** Zero-based image index when the provider encodes page position in the path. */
    imageIndex?: string;
};

export interface ChapterImage {
    url: string;
    width?: number;
    height?: number;
}

export interface ChapterData extends ChapterMeta {
    seriesTitle: string;
    /** Internal API ID for the series, used for tracking on some providers. */
    seriesApiId?: number | string;
    images: ChapterImage[];
}

export interface ChapterMeta {
    chapterId: string;
    /** Internal API ID for tracking on some providers. */
    chapterApiId?: string | number;
}

export interface Provider {
    matchRoute(pathname: string): RouteMatch | null;
    fetchChapter(slug: string, chapterId: string): Promise<ChapterData | null>;
    fetchChaptersNewestFirst(slug: string): Promise<ChapterMeta[]>;
    readerUrl(slug: string, chapterId: string, imageIndex?: string): string;
    seriesUrl(slug: string): string;
    /** Mark a chapter as read / track reading progress. Optional — no-op by default. */
    trackChapter?(data: ChapterData, imageIndex?: string, chaptersNewestFirst?: ChapterMeta[]): Promise<void>;
}
