export enum Handler {
    Home,
    Reader,
}

export enum ChapterLoadIntent {
    Open,
    Append,
}

export enum ChapterLoadResultKind {
    Chapter,
    Navigate,
    Stop,
}

export enum HomeDestinationKind {
    Start,
    Resume,
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
    /** Opaque provider-owned data carried back to provider callbacks. */
    providerData?: unknown;
    images: ChapterImage[];
}

export interface ChapterMeta {
    chapterId: string;
}

export type ChapterOpenRequest = { slug: string; chapterId: string; intent: ChapterLoadIntent.Open };
export type ChapterAppendRequest = { slug: string; chapterId: string; intent: ChapterLoadIntent.Append };
export type ChapterLoadRequest = ChapterOpenRequest | ChapterAppendRequest;

export type ChapterOpenResult =
    | { kind: ChapterLoadResultKind.Chapter; data: ChapterData }
    | { kind: ChapterLoadResultKind.Navigate; url: string };

export type ChapterAppendResult =
    | { kind: ChapterLoadResultKind.Chapter; data: ChapterData }
    | { kind: ChapterLoadResultKind.Stop };

export interface ChapterLoader {
    (request: ChapterOpenRequest): Promise<ChapterOpenResult>;
    (request: ChapterAppendRequest): Promise<ChapterAppendResult>;
}

export type HomeDestinationRequest =
    | { kind: HomeDestinationKind.Start; seriesSlug: string }
    | { kind: HomeDestinationKind.Resume; seriesSlug: string; chapterId: string; imageIndex?: string };

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
    /** Exact provider-owned chapter identities known to be read. */
    readChapterIds: string[];
    /** The chapter the provider considers the current resume point. */
    resumeChapterId: string;
}

export interface Provider {
    /** Stable storage namespace for local progress. */
    key: string;
    /** Title used when takeover happens before the provider page supplies one. */
    documentTitle: string;
    /** Wait until this provider's document is safe to replace. */
    waitForTakeover?: () => Promise<void>;
    matchRoute(pathname: string, hash: string): RouteMatch | null;
    fetchHome(cursor: string | null): Promise<HomePage>;
    fetchRemoteHistory?(): Promise<RemoteSeriesHistory[]>;
    loadChapter: ChapterLoader;
    resolveHomeDestination(request: HomeDestinationRequest): Promise<string>;
    trackChapter?(data: ChapterData): Promise<void>;
    fetchChaptersNewestFirst(slug: string): Promise<ChapterMeta[]>;
    readerUrl(slug: string, chapterId: string, imageIndex?: string): string;
    seriesUrl(slug: string): string;
}
