export enum Handler { Reader }

export type RouteMatch = { handler: Handler.Reader; slug: string; chapter: string };

export interface ChapterImage {
    url: string;
    order: number;
    width: number;
    height: number;
}

export interface ChapterData {
    id?: number;
    slug: string;
    number: number;
    title: string | null;
    content: string | null;
    cover: string;
    publishStatus: string;
    price: number;
    isFree: boolean;
    requiresPurchase: boolean;
    series: { title: string };
    images: ChapterImage[];
    prevUrl: string | null;
    nextUrl: string | null;
}

/// wrong interface!!!
export interface ChapterMeta {
    /** chapter slug — e.g. "chapter-42" or "chapter-1.7" */
    slug: string;
    /** chapter number — float for sub-chapters (e.g. 1.7), integer otherwise */
    number: number;
    /** full URL to the chapter page (yaksha only) */
    url?: string;
}

export interface Provider {
    readonly name: string;

    matchRoute(pathname: string, search: string, hash: string): RouteMatch | null;
    init(): Promise<void>;

    fetchChapter(slug: string, chapter: string): Promise<ChapterData>;
    fetchChapterList(slug: string): Promise<ChapterMeta[]>;
    seriesUrl(slug: string): string;
}
