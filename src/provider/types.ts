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
    nextUrl: string;
}

export interface EzComment {
    id: number;
    content: string;
    status: string;
    isEdited: boolean;
    upvotes: number;
    downvotes: number;
    score: number;
    parentId: number | null;
    replyCount: number;
    author: {
        id: string;
        username: string;
        displayName: string;
        avatar: string;
    };
    userVote: null;
    deletedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface CommentsResponse {
    data: EzComment[];
    totalItems: number;
    totalPages: number;
    current: number;
    next: string | null;
}

export interface MangaComment {
    id: number;
    author: string;
    avatar: string | null;
    content: string;
    createdAt: string;
    score: number;
    replies: MangaComment[];
}

export interface Provider {
    readonly name: string;

    matchRoute(pathname: string, search: string, hash: string): RouteMatch | null;
    init(): Promise<void>;

    fetchChapter(slug: string, chapter: number): Promise<ChapterData>;
    fetchComments(data: ChapterData): Promise<MangaComment[]>;
    seriesUrl(slug: string): string;
}
