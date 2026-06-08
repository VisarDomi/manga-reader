export type LogEvent =
    | { event: 'boot-start' }
    | { event: 'boot-ready'; ms: number; view: string }
    | { event: 'init-crash'; message: string; stack: string; ms: number }
    | { event: 'provider-loaded'; name: string; version?: string; mode: string }
    | { event: 'provider-dynamic-load-failed'; providerId: string; error: string }
    | { event: 'provider-filters-loaded'; source: string; ageMs: number; genres: number; demographics: number; types: number; statuses: number }
    | { event: 'provider-filters-fallback'; error: string; genres: number; demographics: number; types: number; statuses: number }
    | { event: 'search-context-provider-mismatch'; contextProviderId: string; activeProviderId: string; includeGenres: number; excludeGenres: number }
    | { event: 'restore-none' }
    | { event: 'restore-start'; view: string; mangaId: string | null; targetId: string | null; hasSearch: boolean }
    | { event: 'restore-search-done'; view: string }
    | { event: 'restore-target-found'; targetId: string; page: number; scrolled: boolean }
    | { event: 'restore-target-missed'; targetId: string; pagesSearched: number; reason: 'not-found' | 'cancelled' | 'error' | 'no-chapters' }
    | { event: 'restore-ok'; view: string; mangaId?: string }
    | { event: 'restore-fallback'; view: string; reason: string; fallback?: string; error?: string }
    | { event: 'restore-shell'; view: string; stack: string; mangaId: string | null; hasReader: boolean; hasComments: boolean }
    | { event: 'restore-foreground'; view: string; stack: string; mangaId: string | null; hasReader: boolean; hasComments: boolean }
    | { event: 'restore-mounted-layers'; phase: 'foreground' | 'backing' | 'fallback'; foreground: string; stack: string; mounted: string }
    | { event: 'restore-root'; action: 'scheduled' | 'deferred' | 'start' | 'done' | 'failed'; root: 'list' | 'favorites' | 'providers' | 'none'; view: string; targetId?: string | null; reason?: string; error?: string; results?: number; favorites?: number }
    | { event: 'search-result'; requestId?: string; query: string; page: number; resultCount: number; hasMore: boolean; includeGenres: number; excludeGenres: number; demographics: number; authors: number; artists: number; types: number; statuses: number; currentPage?: number; lastPage?: number; total?: number }
    | { event: 'search-page-flow'; action: 'skip' | 'start' | 'done' | 'error' | 'stale'; requestId?: string; query: string; requestedPage: number; currentPage: number; resultCount: number; hasMore: boolean; machineActive: boolean; isRestoring: boolean; added?: number; error?: string }
    | { event: 'cache-reconcile-request'; mangaId: string; observedLatestChapter: number; source: 'search-result' | 'manga-open'; priority: 'observed' | 'foreground' | 'interactive' }
    | { event: 'cache-reconcile-result'; mangaId: string; observedLatestChapter: number | null; cachedMax: number | null; source: 'search-result' | 'manga-open'; priority: 'observed' | 'foreground' | 'interactive'; status: string; action: string; reason: string }
    | { event: 'cache-reconcile-error'; mangaId: string; observedLatestChapter: number; source: 'search-result' | 'manga-open'; priority: 'observed' | 'foreground' | 'interactive'; error: string }
    | { event: 'cache-reconcile-skip'; mangaId: string; observedLatestChapter: number; source: 'search-result'; priority: 'observed'; reason: 'search-generation-changed' }
    | { event: 'manga-card-snapshots-request'; providerId?: string; count: number; includeChapters: boolean }
    | { event: 'manga-card-snapshots-result'; providerId?: string; count: number; includeChapters: boolean; resultCount: number; mangaReady: number; chaptersReady: number; dtMs: number }
    | { event: 'manga-card-snapshots-error'; providerId?: string; count: number; includeChapters: boolean; dtMs: number; error: string }
    | { event: 'manga-open-start'; mangaId: string }
    | { event: 'manga-detail-start'; mangaId: string }
    | { event: 'manga-detail-result'; mangaId: string; tags: number; genres: number; altTitles: number; recommendations: number; description: boolean }
    | { event: 'manga-entry-state'; mangaId: string; phase: 'detail-applied' | 'recommendations-applied' | 'chapters-page' | 'chapters-done' | 'comments-done'; recommendations: number; chapters: number; comments: number }
    | { event: 'manga-detail-error'; mangaId: string; error: string }
    | { event: 'manga-detail-done'; mangaId: string; ms: number }
    | { event: 'manga-scroll-save'; mangaId: string; scrollTop: number; scrollHeight: number; clientHeight: number }
    | { event: 'manga-scroll-restore'; action: 'pending' | 'applied' | 'aborted' | 'waiting' | 'skipped'; mangaId: string; scrollTop: number; currentScrollTop: number; scrollHeight: number; clientHeight: number; reason?: string }
    | { event: 'manga-history-scroll'; action: 'pending' | 'applied' | 'aborted' | 'skipped'; mangaId: string; chapterId: string; reason?: string }
    | { event: 'manga-recommendation-scroll'; action: 'pending' | 'applied' | 'aborted'; mangaId: string; from?: number; to?: number; reason?: string }
    | { event: 'manga-comments-start'; mangaId: string }
    | { event: 'manga-comments-result'; mangaId: string; rootPages: number; replyPages: number; treeFills: number; top: number; total: number; maxDepth: number; missingReplies: number; unavailable: number; unavailableRoots: number; count: number }
    | { event: 'manga-comments-error'; mangaId: string; error: string }
    | { event: 'manga-comments-done'; mangaId: string; ms: number }
    | { event: 'chapter-comments-open'; mangaId: string; chapterId: string; chapterNumber: number }
    | { event: 'chapter-comments-start'; mangaId: string; chapterId: string; chapterNumber: number }
    | { event: 'chapter-comments-result'; mangaId: string; chapterId: string; chapterNumber: number; rootPages: number; replyPages: number; treeFills: number; top: number; total: number; maxDepth: number; missingReplies: number; unavailable: number; unavailableRoots: number; count: number }
    | { event: 'chapter-comments-error'; mangaId: string; chapterId: string; chapterNumber: number; error: string }
    | { event: 'chapter-comments-done'; mangaId: string; chapterId: string; chapterNumber: number; ms: number }
    | { event: 'chapter-comments-commit'; mangaId: string; chapterId: string; chapterNumber: number; mode: 'memory' | 'open' | 'prefetch'; comments: number; commitMs: number }
    | { event: 'chapter-comments-close'; mangaId: string; chapterId: string | null }
    | { event: 'manga-chapters-start'; mangaId: string }
    | { event: 'manga-open-done'; mangaId: string; ms: number }
    | { event: 'chapters-page'; mangaId: string; page: number; items: number; uploadedTimes: number; lastPage?: number; total?: number }
    | { event: 'chapters-parallel'; mangaId: string; remaining: number; total: number }
    | { event: 'chapters-page-error'; mangaId: string; page: number; error: string }
    | { event: 'chapters-stream-error'; mangaId: string; afterFirstPage: boolean; error: string }
    | { event: 'chapters-done'; mangaId: string; pages: number; failed?: number; total: number; uploadedTimes: number }
    | { event: 'chapter-images-result'; providerId?: string; mangaId: string; chapterId: string; chapterNumber: number; imageCount: number; scrambled?: number }
    | { event: 'cache-read'; providerId?: string; resource: 'chapter-list' | 'chapter-images' | 'manga-detail'; action: 'hit' | 'warming' | 'miss'; mangaId: string; chapterId?: string; count?: number; updating?: boolean }
    | { event: 'chapter-list-refresh'; mangaId: string; phase: 'queued' | 'applied' | 'fresh' | 'error'; previousCount: number; nextCount?: number; error?: string }
    | { event: 'reader-window-hydrate-start'; source: 'initial' | 'scroll' | 'visible' | 'retry'; mangaId: string; chapterId: string; chapterNumber: number; side: 'prev' | 'next' | 'current'; priority: number; distance: number; hydrateCount: number }
    | { event: 'reader-window-hydrate-ok'; source: 'initial' | 'scroll' | 'visible' | 'retry'; mangaId: string; chapterId: string; chapterNumber: number; pages: number; estimatedHeight: number; appliedToSlot: boolean }
    | { event: 'reader-window-hydrate-failed'; source: 'initial' | 'scroll' | 'visible' | 'retry'; mangaId: string; chapterId: string; error: string }
    | { event: 'reader-window-local-hit'; source: 'initial' | 'scroll' | 'visible' | 'retry'; mangaId: string; chapterId: string; chapterNumber: number; reason: 'hydrate' | 'render'; pages: number }
    | { event: 'reader-open'; mangaId: string; chapterId: string; chapterNumber: number; hasRestore: boolean }
    | { event: 'reader-scroll-write'; source: 'initial-fallback' | 'initial-restore-into-view' | 'initial-restore-offset' | 'initial-reset' | 'initial-current-anchor' | 'prepend-adjust' | 'layout-idle-anchor' | 'physical-rebase'; from: number; to: number; delta: number; frameEpoch?: number; projectionEpoch?: number }
    | { event: 'reader-scroll-adopted'; source: string; mangaId: string | null; scrollTop: number; logicalScrollTop: number; physicalWindowStart: number; frameEpoch: number }
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
    | { event: 'reader-window-reconcile'; source: 'initial' | 'scroll' | 'visible' | 'retry'; mangaId: string; currentChapterId: string; direction: 'up' | 'down' | 'idle'; scrollTop: number; logicalScrollTop: number; physicalWindowStart: number; projectionEpoch: number; physicalHeight: number; clientHeight: number; wantedCount: number; fetchingCount: number }
    | { event: 'reader-window-slots'; source: 'initial' | 'scroll' | 'visible' | 'retry'; mangaId: string; currentChapterId: string; direction: 'up' | 'down' | 'idle'; radiusPx: number; loadedChapterIds: string; placeholderCount: number }
    | { event: 'reader-window-fetch-start'; source: 'initial' | 'scroll' | 'visible' | 'retry'; mangaId: string; chapterId: string; chapterNumber: number; side: 'prev' | 'next' | 'current'; priority: number; distance: number; fetchingCount: number }
    | { event: 'reader-window-fetch-ok'; source: 'initial' | 'scroll' | 'visible' | 'retry'; mangaId: string; chapterId: string; chapterNumber: number; pages: number; previousEstimatedHeight: number | null; estimatedHeight: number }
    | { event: 'reader-window-height-delta'; source: 'initial' | 'scroll' | 'visible' | 'retry'; mangaId: string; chapterId: string; previousEstimatedHeight: number | null; reservedHeight: number; estimatedHeight: number; delta: number | null }
    | { event: 'reader-window-anchor-projection'; source: 'initial' | 'scroll' | 'visible' | 'retry'; mangaId: string; chapterId: string; anchorChapterId: string; heightDelta: number; physicalStartDelta: number; physicalWindowStart: number; physicalScrollTop: number; frameEpoch: number }
    | { event: 'reader-window-frame'; source: 'initial' | 'scroll' | 'visible' | 'retry'; mangaId: string; currentChapterId: string; epoch: number; projectionEpoch: number; direction: 'up' | 'down' | 'idle'; radiusPx: number; physicalWindowStart: number; physicalScrollTop: number; physicalStartDelta: number; physicalHeight: number; physicalHeightDelta: number; slotsChanged: boolean; loadedChapterIds: string; slotRanges: string; placeholderCount: number }
    | { event: 'reader-stale-physical-observation'; source: 'initial' | 'scroll' | 'visible' | 'retry'; mangaId: string; currentChapterId: string; observedProjectionEpoch: number; currentProjectionEpoch: number; observedScrollTop: number; currentPhysicalScrollTop: number; physicalWindowStart: number; frameEpoch: number }
    | { event: 'reader-projection-transaction'; phase: 'begin' | 'ack' | 'reapply' | 'cancel'; source: 'initial' | 'scroll' | 'visible' | 'retry'; id: number; frameEpoch: number; projectionEpoch: number; from: number; to: number; observed: number; delta: number }
    | { event: 'reader-rebase-deferred'; source: 'initial' | 'scroll' | 'visible' | 'retry'; mangaId: string; activity: string; edge: 'top' | 'bottom'; currentPhysicalScrollTop: number; physicalWindowStart: number; physicalHeight: number; clientHeight: number }
    | { event: 'reader-scroll-session'; phase: 'start' | 'stable' | 'idle-granted' | 'idle-cancelled' | 'rebase-request' | 'rebase-skipped' | 'native-scrollend'; mangaId: string | null; scrollTop: number; stableFrames?: number; quietMs?: number; reason?: string; edge?: 'top' | 'bottom'; sinceStableMs?: number | null; sinceLastScrollMs?: number | null; sinceLastScrollendMs?: number | null }
    | { event: 'reader-layout-measurement'; mangaId: string; chapterId: string; contentHeight: number; slotHeight: number; delta: number }
    | { event: 'reader-layout-prime'; mangaId: string | null; chapterId: string | null; viewportWidth: number; clientHeight: number; changedCount: number; totalDelta: number }
    | { event: 'reader-layout-promotion-frame'; phase: 'queued' | 'fired'; mangaId: string | null; sequence: number; queuedForMs: number; pendingMeasurements: number; scrollTop: number; source?: 'layout' | 'projection'; result?: 'promoted' | 'unchanged' | 'no-root' | 'projection-active' }
    | { event: 'reader-layout-anchor-choice'; mangaId: string | null; currentChapterId: string | null; layoutChapterId: string | null; anchorKey: string | null; selection: 'owner' | 'probe' | 'none'; ownerChapterId: string | null }
    | { event: 'reader-layout-idle-promote'; mangaId: string; changedCount: number; totalDelta: number; anchorKey: string | null }
    | { event: 'reader-scroll-activity'; mangaId: string | null; from: string; to: string; source: string }
    | { event: 'reader-window-hydration-applied'; source: 'initial' | 'scroll' | 'visible' | 'retry'; mangaId: string; chapterId: string; chapterNumber: number; reason: 'current' | 'window'; currentChapterId?: string | null; currentVirtualTop?: number | null; layoutViewportHeight?: number }
    | { event: 'reader-window-fetch-stale'; source: 'initial' | 'scroll' | 'visible' | 'retry'; mangaId: string; chapterId: string; reason: 'epoch' | 'slot-missing' }
    | { event: 'reader-window-fetch-failed'; source: 'initial' | 'scroll' | 'visible' | 'retry'; mangaId: string; chapterId: string; error: string }
    | { event: 'reader-image-schedule'; wanted: number; mounted: number; started: number; revoked?: number; scrollTop: number; clientHeight: number }
    | { event: 'reader-image-schedule-perf'; scrollTop: number; pages: number; jobs: number; kept: number; mounted: number; started: number; revoked: number; totalMs: number; scanMs: number; sortMs: number; startMs: number; cleanupMs: number }
    | { event: 'reader-scroll-perf'; scrollTop: number; deltaScroll: number; sinceLastMs: number; totalMs: number; visualMs: number; queueMs: number; trackerMs: number; pageCount: number; pendingMeasurements: number }
    | { event: 'reader-raf-perf'; source: 'initial' | 'scroll' | 'visible' | 'retry'; queuedForMs: number; totalMs: number; measureMs: number; stateMs: number; tickMs: number; imagesMs: number; scrollTop: number; pendingMeasurements: number }
    | { event: 'reader-reconcile-perf'; source: 'initial' | 'scroll' | 'visible' | 'retry'; queuedForMs: number; totalMs: number; measureMs: number; stateMs: number; tickMs: number; imagesMs: number; scrollTop: number; pendingMeasurements: number }
    | { event: 'reader-frame-gap'; source: 'raf'; gapMs: number; scrollTop: number; pendingMeasurements: number }
    | { event: 'reader-visual-snapshot'; source: 'initial' | 'scroll' | 'images' | 'close'; mangaId: string | null; currentChapterId: string | null; scrollTop: number; clientHeight: number; sections: string; pages: string; visiblePageCount: number; visibleImageCount: number; loadedImageCount: number; emptyImageCount: number }
    | { event: 'reader-surface-snapshot'; source: 'after-images' | 'frame-gap'; mangaId: string | null; currentChapterId: string | null; scrollTop: number; clientHeight: number; scrollHeight: number; stageHeight: number; registeredPages: number; blobUrls: number; loadingImages: number; chapterSections: number; pageElements: number; imgElements: number; imgWithSrc: number; imgComplete: number; visiblePages: number; visibleImages: number; visibleLoadedImages: number; visibleNaturalMegapixels: number; transformActive: boolean; rootClasses: string }
    | { event: 'reader-window-coverage-miss'; source: 'after-images' | 'frame-gap'; mangaId: string | null; currentChapterId: string | null; frameEpoch: number; scrollTop: number; clientHeight: number; scrollHeight: number; stageHeight: number; chapterSections: number; pageElements: number; visibleSections: string; sectionRanges: string }
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
    | { event: 'reader-image-promote'; key: string; from: 'preload'; to: 'critical'; pending: number }
    | { event: 'reader-image-candidate'; key: string; index: number; total: number; ok: boolean; status: number; totalMs: number; host: string; sessionId?: string; policy?: 'critical' | 'preload'; error?: string }
    | { event: 'reader-image-decode-failed'; key: string; index: number; total: number; totalMs: number; host: string; bytes: number; type: string; policy?: 'critical' | 'preload'; naturalWidth: number; naturalHeight: number }
    | { event: 'reader-image-store-report-failed'; key: string; host: string; error: string }
    | { event: 'reader-image-loaded'; key: string; totalMs: number; naturalWidth: number; naturalHeight: number }
    | { event: 'uncaught-error'; message: string; source: string; line: number; col: number; stack: string }
    | { event: 'unhandled-rejection'; message: string; stack: string }
    | { event: 'db-error'; op: string; error: string }
    | { event: 'favorites-toggle-failed'; message: string }
    | { event: 'favorites-backup'; action: 'preview' | 'save' | 'restore' | 'failed'; localCount?: number; remoteCount?: number; providers?: string; error?: string }
    | { event: 'favorites-activation'; phase: 'start' | 'done' | 'failed'; loaded: boolean; items: number; dtMs: number; error?: string }
    | { event: 'favorites-rows-loaded'; rows: number; snapshots: number; items: number; dtMs: number }
    | { event: 'manga-list-lifecycle'; source: 'search' | 'favorites' | 'recommendations'; phase: 'mount' | 'update' | 'unmount'; total: number; trackVisible: boolean; updateCount: number; dtMs: number }
    | { event: 'manga-cover-image-summary'; mountSearch: number; mountFavorites: number; mountRecommendations: number; mountDetail: number; loadSearch: number; loadFavorites: number; loadRecommendations: number; loadDetail: number; errorSearch: number; errorFavorites: number; errorRecommendations: number; errorDetail: number; missingSearch: number; missingFavorites: number; missingRecommendations: number; missingDetail: number; loadAvgMs: number; loadMaxMs: number; errorAvgMs: number; errorMaxMs: number }
    | { event: 'favorites-hydration'; phase: 'start' | 'batch' | 'done' | 'cancelled'; total: number; batchSize: number; batchIndex?: number; count?: number; dtMs: number }
    | { event: 'favorites-hydration-failed'; total: number; dtMs: number; error: string }
    | { event: 'favorites-cover-ready'; providerId: string; phase: 'visible' | 'all'; count: number; ok: number; failed: number; dtMs: number }
    | { event: 'manga-card-subscription-summary'; searchCards: number; favoriteCards: number; recommendationCards?: number; mountedSearch: number; mountedFavorites: number; mountedRecommendations?: number; unmountedSearch: number; unmountedFavorites: number; unmountedRecommendations?: number; progressSearch: number; progressFavorites: number; progressRecommendations?: number; statsSearch: number; statsFavorites: number; statsRecommendations?: number }
    | { event: 'favorites-view-lifecycle'; phase: 'mount' | 'update' | 'unmount'; items: number; isLoading: boolean; updateCount: number; dtMs: number }
    | { event: 'perf-observer-status'; performanceObserver: boolean; supportedEntryTypes: string; longtaskSupported: boolean }
    | { event: 'perf-frame-burst'; source: 'app-raf'; count: number; maxGapMs: number; avgGapMs: number; durationMs: number; view: string; backView: string | null; isSwiping: boolean; isForwardSwiping: boolean; searchResults: number; favorites: number; activeMangaId: string | null; activeChapters: number; activeComments: number; readerChapters: number; readerPages: number; searchCards: number; favoriteCards: number }
    | { event: 'foreground-work'; owner: 'search' | 'manga-comments'; action: 'run' | 'defer' | 'resume' | 'cancel'; view: string; reason?: string; count?: number; mangaId?: string };

type EventName = LogEvent['event'];
type PayloadOf<E extends EventName> = Omit<Extract<LogEvent, { event: E }>, 'event'>;
type HasPayload<E extends EventName> = keyof PayloadOf<E> extends never ? false : true;

export type LogEmit = <E extends EventName>(
    ...args: HasPayload<E> extends true ? [event: E, data: PayloadOf<E>] : [event: E]
) => void;

export class LogService {
    private cleanups: (() => void)[] = [];
    private enabled = false;

    get isEnabled(): boolean {
        return this.enabled;
    }

    async start(): Promise<void> {
        if (typeof window === 'undefined') return;

        try {
            const response = await fetch('/api/log/config', { cache: 'no-store' });
            const config = await response.json();
            this.enabled = config?.enabled === true;
        } catch {
            this.enabled = false;
        }

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
        if (!this.enabled) return;
        fetch('/api/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event, data }),
        }).catch(() => {});
    }) as LogEmit;

    destroy(): void {
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
        this.enabled = false;
    }
}
