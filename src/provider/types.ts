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
    /** Canonical catalog slug used for history and chapter-list requests. */
    seriesSlug: string;
    /** Internal API ID for the series, used for tracking on some providers. */
    seriesApiId?: number | string;
    images: ChapterImage[];
}

export interface ChapterMeta {
    chapterId: string;
    /** Internal API ID for tracking on some providers. */
    chapterApiId?: string | number;
}

export interface HomeChapter {
    chapterId: string;
    label: string;
    /** An ISO timestamp or a provider-supplied relative/absolute date label. */
    uploadedAt: string | null;
    locked: boolean;
    unlockAt: string | null;
}

export interface HomeSeries {
    slug: string;
    /** Provider-owned identity used to join catalog entries with remote history. */
    historyId?: string;
    title: string;
    coverUrl: string;
    chapters: HomeChapter[];
}

export interface HomePage {
    series: HomeSeries[];
    /** Opaque provider-owned cursor for the next bulk catalog request. */
    nextCursor: string | null;
    total?: number;
}

export interface RemoteSeriesHistory {
    /** Matches HomeSeries.historyId, or HomeSeries.slug when no separate identity is needed. */
    seriesId: string;
    /** Every chapter through this provider-defined boundary has been read. */
    readThroughChapterId?: string;
    /** The chapter the provider considers the current resume point. */
    resumeChapterId: string;
    /** Page progress within resumeChapterId, when the provider exposes it. */
    resumePercent?: number;
}

export interface Provider {
    /** Stable storage namespace for local progress. */
    key: string;
    /** Title used when takeover happens before the provider page supplies one. */
    documentTitle: string;
    /** Wait until this provider's document is safe to replace. */
    waitForTakeover?: () => Promise<void>;
    tokenManager?: TokenManager;
    matchRoute(pathname: string, hash: string): RouteMatch | null;
    fetchHome(cursor: string | null): Promise<HomePage>;
    /** Fetch authenticated provider history as an optional, non-blocking sidecar. */
    fetchRemoteHistory?(): Promise<RemoteSeriesHistory[]>;
    fetchChapter(slug: string, chapterId: string): Promise<ChapterData | null>;
    fetchChaptersNewestFirst(slug: string): Promise<ChapterMeta[]>;
    readerUrl(slug: string, chapterId: string, imageIndex?: string): string;
    seriesUrl(slug: string): string;
    /** Track progress for a visible page. Optional — no-op by default. */
    trackPage?(data: ChapterData, imageIndex: string, chaptersNewestFirst: ChapterMeta[]): Promise<void>;
    /** Mark a chapter as read and/or record a chapter view. Optional — no-op by default. */
    trackChapter?(data: ChapterData): Promise<void>;
}
