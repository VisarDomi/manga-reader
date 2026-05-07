export type { Manga, ChapterMeta, ChapterPage } from '@manga-reader/provider-types';

export interface MangaComment {
    id: number;
    parentId: number;
    author: string;
    avatar?: string;
    content: string;
    createdAt: string;
    likeCount: number;
    dislikeCount: number;
    replyCount: number;
    replies: MangaComment[];
}

export interface LoadedChapter {
    id: string;
    number: number;
    pages: import('@manga-reader/provider-types').ChapterPage[];
    groupName: string;
    unloaded?: boolean;
}

export type ViewMode = 'list' | 'favorites' | 'manga' | 'reader';

export interface ReaderPageData {
    key: string;
    url: string;
}
