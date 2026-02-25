export const API = {
    SEARCH_BASE: '/api/search',
    CHAPTERS: (slug: string, page = 1, limit = 100) =>
        `/api/manga/${slug}/chapters?limit=${limit}&page=${page}`,
    CHAPTER_IMAGES: (slug: string, chapterId: number, chapterNumber: number) =>
        `/api/chapter/${slug}/${chapterId}/${chapterNumber}`,
    IMAGE_PROXY: (url: string) =>
        `/api/image?url=${encodeURIComponent(url)}`,
    HISTORY_UPDATE: () => `/api/history`,
    HISTORY_GET: (mangaId: number) => `/api/history/${mangaId}`,
    FAVORITES: '/api/favorites',
    FAVORITE: (slug: string) => `/api/favorites/${slug}`,
};
