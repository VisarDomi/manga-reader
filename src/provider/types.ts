import type { TokenManager } from '../core/token-manager';

export enum Handler {
    Home,
    Reader,
}

export type RouteMatch =
    | { handler: Handler.Home }
    | {
        handler: Handler.Reader;
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
    tokenManager: TokenManager;
    matchRoute(pathname: string, hash: string): RouteMatch | null;
    fetchChapter(slug: string, chapterId: string): Promise<ChapterData | null>;
    fetchChaptersNewestFirst(slug: string): Promise<ChapterMeta[]>;
    readerUrl(slug: string, chapterId: string, imageIndex?: string): string;
    seriesUrl(slug: string): string;
    /** Track progress for a visible page. Optional — no-op by default. */
    trackPage?(data: ChapterData, imageIndex: string, chaptersNewestFirst: ChapterMeta[]): Promise<void>;
    /** Mark a chapter as read and/or record a chapter view. Optional — no-op by default. */
    trackChapter?(data: ChapterData): Promise<void>;
}
