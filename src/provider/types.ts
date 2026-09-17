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
    /** Provider-owned identity used to join catalog entries with local progress. */
    historyId?: string;
    title: string;
    coverUrl: string;
    chapters: HomeChapter[];
}

export interface HomePage {
    series: HomeSeries[];
    /** Opaque provider-owned cursor for the next bulk catalog request. */
    nextCursor: string | null;
    /** Known later cursors, in provider order, available for bounded prefetch. */
    prefetchCursors?: string[];
    total?: number;
}

export interface Provider {
    /** Stable storage namespace for local progress. */
    key: string;
    /** Optional provider-owned canonical identity, also used by native file keys. */
    historyId?(slug: string): string;
    matchRoute(pathname: string, hash: string): RouteMatch | null;
    fetchHome(cursor: string | null): Promise<HomePage>;
    loadChapter: ChapterLoader;
    resolveHomeDestination(request: HomeDestinationRequest): Promise<string>;
    fetchChaptersNewestFirst(slug: string): Promise<ChapterMeta[]>;
    readerUrl(slug: string, chapterId: string, imageIndex?: string): string;
    seriesUrl(slug: string): string;
}
