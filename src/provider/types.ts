export interface GalleryFile {
    key: string;
    name: string;
    width: number;
    height: number;
}

export interface GalleryMeta {
    title: string;
    title_jpn: string;
    type: string;
    language: string;
    date: string;
    artists: string[];
    groups: string[];
    parody: string[];
    characters: string[];
    tags: { tag: string; female?: string; male?: string }[];
    files: GalleryFile[];
}

export enum Handler { Home, Search, Reader }

export type RouteMatch =
    | { handler: Handler.Home }
    | { handler: Handler.Search; query: string; page: number }
    | { handler: Handler.Reader; gid: number; index: number };

export interface SearchPage {
    ids: number[];
    totalResults: number;
    pageSize: number;
}

export interface Provider {
    readonly name: string;

    matchRoute(pathname: string, search: string, hash: string): RouteMatch | null;
    init(): Promise<void>;

    // ── core ──────────────────────────────────────────────────────────
    search(rawQuery: string, page: number): Promise<SearchPage>;
    /** Navigate to a search page. Provider decides hash vs URL navigation. */
    goToPage(rawQuery: string, page: number): void;
    fetchMeta(gid: number): Promise<GalleryMeta>;

    // ── URL constructors ──────────────────────────────────────────────
    readerUrl(gid: number, index?: number): string;
    searchUrl(rawQuery: string, page?: number): string;
    /** Build a search URL from a tag/artist/etc click in the info modal. */
    tagSearchUrl(ns: string, value: string, language: string): string;
    thumbUrl(file: GalleryFile): string;
    imageUrls(files: GalleryFile[]): Promise<string[]>;
}
