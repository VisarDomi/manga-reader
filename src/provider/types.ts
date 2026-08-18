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
    /** Provider-owned identity for LOCAL history keys. May differ from
     * seriesSlug (e.g. asura drops the rotating URL hex). The core never
     * derives it and never inspects its meaning. */
    historyId?: string;
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
    /** When true, the compute worker performs the catalog fetch + mapping. */
    catalogInWorker?: boolean;
    /** Title used when takeover happens before the provider page supplies one. */
    documentTitle: string;
    /** Wait until this provider's document is safe to replace. */
    waitForTakeover?: () => Promise<void>;
    /** Authenticated history and tracking run in the compute worker. */
    remoteHistoryInWorker?: boolean;
    matchRoute(pathname: string, hash: string): RouteMatch | null;
    fetchHome(cursor: string | null): Promise<HomePage>;
    fetchChapter(slug: string, chapterId: string): Promise<ChapterData | null>;
    /** The image index of a chapter's LAST page, for resuming at the end of a
     * read chapter when only server history exists. Provider-specific: the
     * core never derives page counts from chapter data itself. */
    lastReadImageIndex?(slug: string, chapterId: string): Promise<string | undefined>;
    /** The image index for a server progress percentage (partial resume).
     * Provider-specific: what a percentage means belongs to the provider. */
    resumeImageIndex?(slug: string, chapterId: string, percent: number): Promise<string | undefined>;
    fetchChaptersNewestFirst(slug: string): Promise<ChapterMeta[]>;
    readerUrl(slug: string, chapterId: string, imageIndex?: string): string;
    seriesUrl(slug: string): string;
}
