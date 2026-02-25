export interface Manga {
    slug: string;
    title: string;
    cover: string;
    latestChapter: number | null;
    author?: string;
    status?: string;
    termIds?: number[];
}

export interface ChapterMeta {
    chapterId: number;
    number: number;
    scanlationGroupId: number;
    scanlationGroupName: string;
    votes: number;
    mangaId?: number;
    uploadedAt?: number;
}

export interface ChapterPage {
    url: string;
    width: number;
    height: number;
}

export interface LoadedChapter {
    chapterId: number;
    number: number;
    pages: ChapterPage[];
    groupName: string;
    /** Set to true when images have been revoked for memory management */
    unloaded?: boolean;
}

export type ViewMode = 'list' | 'manga' | 'reader';

export interface ReaderPageData {
    key: string;
    url: string;
}

// API response shapes (match backend JSON structure)

export interface SearchApiResponse {
    result?: { items: Record<string, unknown>[] };
    items?: Record<string, unknown>[];
}

export interface ChaptersApiResponse {
    result?: { items: Record<string, unknown>[] };
}

export interface ChapterImagesApiResponse {
    images: { url: string; width: number; height: number }[];
}

export interface HistoryApiResponse {
    result?: { chapter_id?: number; chapter?: { chapter_id?: number } };
}
