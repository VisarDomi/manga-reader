export type LogEvent =
    | { event: 'boot-start' }
    | { event: 'boot-ready'; ms: number; view: string }
    | { event: 'init-crash'; message: string; stack: string; ms: number }
    | { event: 'provider-loaded'; name: string; version?: string; mode: string }
    | { event: 'provider-filters-loaded'; source: string; ageMs: number; genres: number; demographics: number; types: number; statuses: number }
    | { event: 'provider-filters-fallback'; error: string; genres: number; demographics: number; types: number; statuses: number }
    | { event: 'restore-none' }
    | { event: 'restore-start'; view: string; mangaId: string | null; targetId: string | null; hasSearch: boolean }
    | { event: 'restore-search-done'; view: string }
    | { event: 'restore-target-found'; targetId: string; page: number; scrolled: boolean }
    | { event: 'restore-target-missed'; targetId: string; pagesSearched: number; reason: 'not-found' | 'cancelled' | 'error' | 'no-chapters' }
    | { event: 'restore-ok'; view: string; mangaId?: string }
    | { event: 'restore-fallback'; view: string; reason: string; fallback?: string }
    | { event: 'search-result'; query: string; page: number; resultCount: number; hasMore: boolean; includeGenres: number; excludeGenres: number; demographics: number; authors: number; artists: number; types: number; statuses: number; currentPage?: number; lastPage?: number; total?: number }
    | { event: 'manga-open-start'; mangaId: string }
    | { event: 'manga-detail-start'; mangaId: string }
    | { event: 'manga-detail-result'; mangaId: string; tags: number; genres: number; altTitles: number; recommendations: number; description: boolean }
    | { event: 'manga-entry-state'; mangaId: string; phase: 'detail-applied' | 'chapters-page' | 'chapters-done' | 'comments-done'; recommendations: number; chapters: number; comments: number }
    | { event: 'manga-detail-error'; mangaId: string; error: string }
    | { event: 'manga-detail-done'; mangaId: string; ms: number }
    | { event: 'manga-comments-start'; mangaId: string }
    | { event: 'manga-comments-result'; mangaId: string; rootPages: number; replyPages: number; treeFills: number; top: number; total: number; maxDepth: number; missingReplies: number; unavailable: number; unavailableRoots: number; count: number }
    | { event: 'manga-comments-error'; mangaId: string; error: string }
    | { event: 'manga-comments-done'; mangaId: string; ms: number }
    | { event: 'chapter-comments-open'; mangaId: string; chapterId: string; chapterNumber: number }
    | { event: 'chapter-comments-start'; mangaId: string; chapterId: string; chapterNumber: number }
    | { event: 'chapter-comments-result'; mangaId: string; chapterId: string; chapterNumber: number; rootPages: number; replyPages: number; treeFills: number; top: number; total: number; maxDepth: number; missingReplies: number; unavailable: number; unavailableRoots: number; count: number }
    | { event: 'chapter-comments-error'; mangaId: string; chapterId: string; chapterNumber: number; error: string }
    | { event: 'chapter-comments-done'; mangaId: string; chapterId: string; chapterNumber: number; ms: number }
    | { event: 'chapter-comments-close'; mangaId: string; chapterId: string | null }
    | { event: 'manga-chapters-start'; mangaId: string }
    | { event: 'manga-open-done'; mangaId: string; ms: number }
    | { event: 'chapters-page'; mangaId: string; page: number; items: number; uploadedTimes: number; lastPage?: number; total?: number }
    | { event: 'chapters-parallel'; mangaId: string; remaining: number; total: number }
    | { event: 'chapters-page-error'; mangaId: string; page: number; error: string }
    | { event: 'chapters-done'; mangaId: string; pages: number; failed?: number; total: number; uploadedTimes: number }
    | { event: 'chapter-detail-prewarm-choice'; mangaId: string; chapterId: string; chapterNumber: number; reason: 'history' | 'unread' }
    | { event: 'chapter-images-result'; mangaId: string; chapterId: string; chapterNumber: number; imageCount: number }
    | { event: 'reader-open'; mangaId: string; chapterId: string; chapterNumber: number; hasRestore: boolean }
    | { event: 'reader-scroll-write'; source: 'initial-fallback' | 'initial-restore-into-view' | 'initial-restore-offset' | 'initial-reset' | 'initial-current-anchor' | 'prepend-adjust' | 'layout-idle-anchor'; from: number; to: number; delta: number }
    | { event: 'reader-restore-scroll'; action: 'restored' | 'reset' | 'cancelled' | 'fallback'; target: 'page' | 'top'; reason?: string; pageIndex?: number; scrollOffset?: number; from?: number; to?: number; delta?: number }
    | { event: 'reader-edge-load-start'; edge: 'next' | 'prev'; mangaId: string; targetChapterId: string; targetChapterNumber: number; currentChapterId: string | null; firstLoadedChapterId: string | null; lastLoadedChapterId: string | null; loadedCount: number }
    | { event: 'reader-edge-retry'; edge: 'next' | 'prev'; mangaId: string; chapterId: string; attempt: number; error: string }
    | { event: 'reader-append-ok'; mangaId: string; chapterId: string; chapterNumber: number }
    | { event: 'reader-append-skipped'; reason: 'loading' | 'no-manga' | 'no-loaded' | 'no-next' | 'already-loaded' }
    | { event: 'reader-append-failed'; mangaId: string; chapterId: string; error: string }
    | { event: 'reader-prepend-ok'; mangaId: string; chapterId: string; chapterNumber: number }
    | { event: 'reader-prepend-skipped'; reason: 'loading' | 'no-manga' | 'no-loaded' | 'no-prev' | 'already-loaded' }
    | { event: 'reader-prepend-failed'; mangaId: string; chapterId: string; error: string }
    | { event: 'reader-prepend-layout'; phase: 'begin' | 'loaded' | 'after-tick' | 'after-commit'; rootScrollTop: number; anchorChapterId: string | null; anchorTop: number | null; anchorBottom: number | null; anchorConnected: boolean; loadedChapterIds: string }
    | { event: 'reader-prepend-scroll'; action: 'adjusted' | 'none'; reason?: string; diff?: number; delta?: number; userDelta?: number; anchorTop?: number; targetTop?: number }
    | { event: 'reader-window-reconcile'; source: 'initial' | 'scroll' | 'visible' | 'retry'; mangaId: string; currentChapterId: string; direction: 'up' | 'down' | 'idle'; scrollTop: number; clientHeight: number; wantedCount: number; fetchingCount: number }
    | { event: 'reader-window-slots'; source: 'initial' | 'scroll' | 'visible' | 'retry'; mangaId: string; currentChapterId: string; direction: 'up' | 'down' | 'idle'; radiusPx: number; loadedChapterIds: string; placeholderCount: number }
    | { event: 'reader-window-fetch-start'; source: 'initial' | 'scroll' | 'visible' | 'retry'; mangaId: string; chapterId: string; chapterNumber: number; side: 'prev' | 'next' | 'current'; priority: number; distance: number; fetchingCount: number }
    | { event: 'reader-window-fetch-ok'; source: 'initial' | 'scroll' | 'visible' | 'retry'; mangaId: string; chapterId: string; chapterNumber: number; pages: number; previousEstimatedHeight: number | null; estimatedHeight: number }
    | { event: 'reader-window-height-delta'; source: 'initial' | 'scroll' | 'visible' | 'retry'; mangaId: string; chapterId: string; previousEstimatedHeight: number | null; estimatedHeight: number; delta: number | null }
    | { event: 'reader-layout-measurement'; mangaId: string; chapterId: string; contentHeight: number; slotHeight: number; delta: number }
    | { event: 'reader-layout-anchor-choice'; mangaId: string | null; currentChapterId: string | null; layoutChapterId: string | null; anchorKey: string | null; selection: 'owner' | 'probe' | 'none'; ownerChapterId: string | null }
    | { event: 'reader-layout-idle-promote'; mangaId: string; changedCount: number; totalDelta: number; anchorKey: string | null }
    | { event: 'reader-window-hydration-applied'; source: 'initial' | 'scroll' | 'visible' | 'retry'; mangaId: string; chapterId: string; chapterNumber: number; reason: 'current' | 'window'; currentChapterId?: string | null; currentVirtualTop?: number | null; layoutViewportHeight?: number }
    | { event: 'reader-window-fetch-stale'; source: 'initial' | 'scroll' | 'visible' | 'retry'; mangaId: string; chapterId: string; reason: 'epoch' | 'slot-missing' }
    | { event: 'reader-window-fetch-failed'; source: 'initial' | 'scroll' | 'visible' | 'retry'; mangaId: string; chapterId: string; error: string }
    | { event: 'reader-image-schedule'; wanted: number; mounted: number; started: number; revoked?: number; scrollTop: number; clientHeight: number }
    | { event: 'reader-visual-snapshot'; source: 'initial' | 'scroll' | 'images' | 'close'; mangaId: string | null; currentChapterId: string | null; scrollTop: number; clientHeight: number; sections: string; pages: string; visiblePageCount: number; visibleImageCount: number; loadedImageCount: number; emptyImageCount: number }
    | { event: 'reader-chapter-change'; mangaId: string; fromChapterId: string | null; toChapterId: string }
    | { event: 'reader-visible-page'; source: 'scroll' | 'close'; mangaId: string; currentChapterId: string | null; visibleChapterId: string; pageIndex: number; rootScrollTop: number; pageTop: number; pageBottom: number; probeY: number; selection?: 'owner' | 'probe'; ownerChapterId?: string | null }
    | { event: 'reader-close-snapshot'; mangaId: string; currentChapterId: string | null; visibleChapterId: string | null; pageIndex?: number; rootScrollTop?: number; pageTop?: number; pageBottom?: number; loadedChapterIds: string }
    | { event: 'reader-close'; mangaId: string; chapterId: string | null; backMangaId: string | null; backEntryKey: string | null }
    | { event: 'progress-save'; source?: 'open' | 'scheduled' | 'close'; mangaId: string; chapterId: string; chapterNumber: number; pageIndex?: number; pageCount?: number }
    | { event: 'view-push'; from: string; to: string }
    | { event: 'view-pop'; from: string; to: string }
    | { event: 'view-reset'; to: string }
    | { event: 'resume'; kind: string; elapsedMs: number; view: string }
    | { event: 'resume-recover'; view: string; searchWasStuck: boolean; resultCount: number; currentPage: number; query: string }
    | { event: 'watchdog-freeze'; gapMs: number }
    | { event: 'sentinel-forced-resume'; frozenSeconds: number }
    | { event: 'img-fail'; key: string; totalMs: number; error: string; pending: number }
    | { event: 'uncaught-error'; message: string; source: string; line: number; col: number; stack: string }
    | { event: 'unhandled-rejection'; message: string; stack: string }
    | { event: 'db-error'; op: string; error: string }
    | { event: 'favorites-toggle-failed'; message: string }
    | { event: 'prewarm-sent'; count: number }
    | { event: 'chapter-warmup-sent'; count: number };

type EventName = LogEvent['event'];
type PayloadOf<E extends EventName> = Omit<Extract<LogEvent, { event: E }>, 'event'>;
type HasPayload<E extends EventName> = keyof PayloadOf<E> extends never ? false : true;

export type LogEmit = <E extends EventName>(
    ...args: HasPayload<E> extends true ? [event: E, data: PayloadOf<E>] : [event: E]
) => void;

export class LogService {
    private cleanups: (() => void)[] = [];

    start(): void {
        if (typeof window === 'undefined') return;

        const onError = (event: ErrorEvent) => {
            this.emit('uncaught-error', {
                message: event.message,
                source: event.filename ?? '',
                line: event.lineno ?? 0,
                col: event.colno ?? 0,
                stack: event.error?.stack ?? '',
            });
        };

        const onRejection = (event: PromiseRejectionEvent) => {
            const reason = event.reason;
            this.emit('unhandled-rejection', {
                message: String(reason?.message ?? reason),
                stack: reason?.stack ?? '',
            });
        };

        window.addEventListener('error', onError);
        window.addEventListener('unhandledrejection', onRejection);
        this.cleanups.push(
            () => window.removeEventListener('error', onError),
            () => window.removeEventListener('unhandledrejection', onRejection),
        );
    }

    emit: LogEmit = ((event: string, data?: Record<string, unknown>) => {
        fetch('/api/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event, data }),
        }).catch(() => {});
    }) as LogEmit;

    destroy(): void {
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
    }
}
