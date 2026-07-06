export enum Handler { Reader }

export type RouteMatch = { handler: Handler.Reader; slug: string; chapter: number };

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

export interface Provider {
    readonly name: string;

    matchRoute(pathname: string, search: string, hash: string): RouteMatch | null;
    init(): Promise<void>;

    fetchChapter(slug: string, chapter: number): Promise<ChapterData>;
    seriesUrl(slug: string): string;
}
