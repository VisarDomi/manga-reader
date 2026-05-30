export type { Manga, ChapterMeta, ChapterPage } from '@manga-reader/provider-types';

export interface MangaComment {
    id: number;
    parentId: number;
    author: string;
    avatar?: string;
    content: string;
    parts?: MangaCommentPart[];
    createdAt: string;
    likeCount: number;
    dislikeCount: number;
    replyCount: number;
    replies: MangaComment[];
}

export type MangaCommentPart =
    | { type: 'text'; text: string }
    | { type: 'spoiler'; text: string }
    | { type: 'image'; url: string; alt: string };

export interface MangaCommentStats {
    total: number;
    maxDepth: number;
    parents: number;
    missingReplies: number;
    rootPages: number;
    replyPages: number;
    treeFills: number;
    unavailable: number;
    unavailableRoots: number;
}

export interface LoadedChapter {
    id: string;
    number: number;
    pages: import('@manga-reader/provider-types').ChapterPage[];
    groupName: string;
    slotState?: 'placeholder' | 'loading' | 'ready' | 'cold' | 'unloaded';
    estimatedHeight?: number;
    virtualTop?: number;
    virtualHeight?: number;
    logicalTop?: number;
    logicalHeight?: number;
    unloaded?: boolean;
}

export type ViewMode = 'list' | 'favorites' | 'manga' | 'reader' | 'chapter-comments';

export interface ReaderPageData {
    key: string;
    url: string;
    candidates: string[];
    criticalCandidates?: string[];
}

export interface ReaderPageGeometry {
    key: string;
    url: string;
    candidates: string[];
    criticalCandidates?: string[];
    chapterId: string;
    pageIndex: number;
    top: number;
    bottom: number;
    height: number;
}
