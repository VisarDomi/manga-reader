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

export interface ChapterMeta {
    slug: string;
}

export interface Provider {
    readonly name: string;

    matchRoute(pathname: string): RouteMatch | null;
    init(): Promise<void>;

    fetchChapter(slug: string, chapterId: string): Promise<ChapterData>;
    fetchChapterList(slug: string): Promise<ChapterMeta[]>;
    readerUrl(slug: string, chapterId: string, imgIdx?: string): string;
    seriesUrl(slug: string): string;
    getNextChapter(chapterList: ChapterMeta[], lastChapter: string): ChapterMeta;
}
