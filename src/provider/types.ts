export enum Handler { Reader }

export type RouteMatch = { handler: Handler.Reader; slug: string; chapter: string };

export interface ChapterImage {
    url: string;
    order: number;
    width: number;
    height: number;
}

export interface ChapterData {
    number: number;
    series: { title: string };
    /** Series ID, used for tracking/read progress on some providers. */
    seriesId?: number | string;
    /** Chapter ID, used for tracking/views on some providers. */
    chapterNumericId?: number | string;
    images: ChapterImage[];
}

export interface ChapterMeta {
    slug: string;
    id?: string;
}

export interface Provider {
    matchRoute(pathname: string): RouteMatch | null;
    init(): Promise<void>;

    fetchChapter(slug: string, chapterId: string): Promise<ChapterData>;
    fetchChapterList(slug: string): Promise<ChapterMeta[]>;
    readerUrl(slug: string, chapterId: string, imgIdx?: string): string;
    seriesUrl(slug: string): string;
    getNextChapter(chapterList: ChapterMeta[], lastChapter: string): ChapterMeta;
    /** Mark a chapter as read / track reading progress. Optional — no-op by default. */
    trackChapter?(data: ChapterData, image?: string, chapterList?: ChapterMeta[]): Promise<void>;
}
