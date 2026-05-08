import type { Manga, ChapterMeta, LoadedChapter, MangaComment, MangaCommentStats } from '../types.js';
import { View } from '../logic.js';
import { Msg } from '../messages.js';
import * as api from '../services/api.js';
import * as db from '../services/db.js';
import type { LogService } from '../services/LogService.js';
import { PageTracker, type VisiblePageSnapshot } from '../services/PageTracker.js';
import { ReaderWindowManager, type ReaderScrollDirection, type ReaderWindowSource, type WindowCandidate } from '../services/ReaderWindowManager.js';
import type { UIState } from './ui.svelte.js';
import type { MangaState } from './manga.svelte.js';
import type { ProgressState } from './progress.svelte.js';
import type { ToastState } from './toast.svelte.js';
import { type LoadError, toLoadError } from './errors.js';
import {
    CHAPTER_WARM_NEXT,
    CHAPTER_WARM_PREV,
    READER_CHAPTER_SEPARATOR_HEIGHT,
    READER_DOM_KEEP_RADIUS_VIEWPORTS,
    READER_FALLBACK_PAGE_ASPECT_RATIO,
    READER_WINDOW_RADIUS_VIEWPORTS,
} from '../constants.js';

type ReaderEdge = 'next' | 'prev';

type ChapterLoadRequest = {
    manga: Manga;
    chapter: ChapterMeta;
};

type ChapterLoadResult =
    | { kind: 'loaded'; chapter: LoadedChapter }
    | { kind: 'stale' }
    | { kind: 'failed'; error: unknown };

type RetryWaitResult = 'timer' | 'manual' | 'stale';
const EDGE_LOAD_RETRY_DELAYS_MS = [750, 1500] as const;

export interface ReaderTitleContext {
    chapterNumber: number;
    groupName: string;
}

export interface ChapterCommentsContext extends ReaderTitleContext {
    mangaId: string;
    chapterId: string;
    mangaTitle: string;
}

const EMPTY_COMMENT_STATS: MangaCommentStats = {
    total: 0,
    maxDepth: 0,
    parents: 0,
    missingReplies: 0,
    rootPages: 0,
    replyPages: 0,
    treeFills: 0,
    unavailable: 0,
    unavailableRoots: 0,
};

export class ReaderState {
    loadedChapters = $state<LoadedChapter[]>([]);
    currentChapterId = $state<string | null>(null);
    layoutChapterId = $state<string | null>(null);
    error = $state<LoadError | null>(null);
    isLoadingNext = $state(false);
    isLoadingPrev = $state(false);
    nextChapterRetryAvailable = $state(false);
    pendingPageRestore = $state<{ pageIndex: number; scrollOffset: number } | null>(null);
    chapterComments = $state<MangaComment[]>([]);
    chapterCommentsCount = $state(0);
    chapterCommentsStats = $state<MangaCommentStats>({ ...EMPTY_COMMENT_STATS });
    isChapterCommentsLoading = $state(false);
    chapterCommentsError = $state<string | null>(null);
    chapterCommentsContext = $state<ChapterCommentsContext | null>(null);
    virtualTotalHeight = $state(0);
    private activeMangaId = '';
    private mangaEntryKey: string | null = null;
    private chapterList: ChapterMeta[] = [];
    private loadEpoch = 0;
    private commentsEpoch = 0;
    private commentsAbort: AbortController | null = null;
    private nextRetryWake: (() => void) | null = null;
    private windowEpoch = 0;
    private windowFetches = new Set<string>();
    private lastWindowScrollTop = 0;
    private lastViewportWidth = 0;
    private lastViewportHeight = 0;
    private measuredChapterHeights = new Map<string, number>();
    private mangaAverageChapterHeight: number | null = null;
    private windowManager = new ReaderWindowManager();
    readonly pageTracker = new PageTracker();

    private ui: UIState;
    private manga: MangaState;
    private progress: ProgressState;
    private toast: ToastState;
    private log: LogService;

    constructor(ui: UIState, manga: MangaState, progress: ProgressState, toast: ToastState, log: LogService) {
        this.ui = ui;
        this.manga = manga;
        this.progress = progress;
        this.toast = toast;
        this.log = log;
    }

    async openReader(manga: Manga, chapter: ChapterMeta, mangaEntryKey: string | null = this.manga.activeEntryKey) {
        this.loadEpoch++;
        this.windowEpoch++;
        this.windowFetches.clear();
        this.lastViewportWidth = 0;
        this.lastViewportHeight = 0;
        this.measuredChapterHeights.clear();
        this.mangaAverageChapterHeight = null;
        this.nextRetryWake = null;
        this.activeMangaId = manga.id;
        this.mangaEntryKey = mangaEntryKey;
        this.currentChapterId = chapter.id;
        this.layoutChapterId = chapter.id;
        this.loadedChapters = [];
        this.virtualTotalHeight = 0;
        this.isLoadingNext = false;
        this.isLoadingPrev = false;
        this.nextChapterRetryAvailable = false;
        this.chapterList = [...this.manga.filteredChapters].sort((a, b) => a.number - b.number);

        const saved = this.progress.get(manga.id);
        const hasRestore = !!(saved && saved.chapterId === chapter.id && saved.pageIndex != null);
        if (hasRestore) {
            this.pendingPageRestore = { pageIndex: saved!.pageIndex!, scrollOffset: saved!.scrollOffset ?? 0 };
        } else {
            this.pendingPageRestore = null;
        }

        this.log.emit('reader-open', { mangaId: manga.id, chapterId: chapter.id, chapterNumber: chapter.number, hasRestore });
        this.ui.pushView(View.READER);

        try {
            const pages = await api.fetchChapterImages(manga.id, chapter.id, chapter.number, chapter.url);
            const proxiedPages = pages.map(p => ({
                ...p,
                url: api.imageProxyUrl(p.url, manga.id, chapter.id, chapter.number, chapter.url),
            }));
            this.error = null;
            this.loadedChapters = [{
                id: chapter.id,
                number: chapter.number,
                pages: proxiedPages,
                groupName: chapter.groupName,
                slotState: 'ready',
                estimatedHeight: this.estimateLoadedChapterHeight(proxiedPages, 0),
            }];
            this.loadedChapters = this.positionVirtualSlots(this.loadedChapters, chapter.id, 0, 0);
            this.scheduleChapterWarmup(manga, chapter.id);

            if (!hasRestore) {
                const progressData = { chapterId: chapter.id, chapterNumber: chapter.number };
                db.setProgress(manga.id, progressData);
                this.progress.update(manga.id, progressData);
                this.log.emit('progress-save', { source: 'open', mangaId: manga.id, ...progressData });
            }
        } catch (e) {
            this.error = toLoadError(e);
        }
    }

    async restoreReader(manga: Manga): Promise<boolean> {
        const saved = this.progress.get(manga.id);
        if (!saved) return false;

        const filtered = this.manga.filteredChapters;
        const chapter = filtered.find(c => c.id === saved.chapterId);
        if (!chapter) return false;

        this.loadEpoch++;
        this.windowEpoch++;
        this.windowFetches.clear();
        this.lastViewportWidth = 0;
        this.lastViewportHeight = 0;
        this.measuredChapterHeights.clear();
        this.mangaAverageChapterHeight = null;
        this.nextRetryWake = null;
        this.activeMangaId = manga.id;
        this.mangaEntryKey = this.manga.activeEntryKey;
        this.currentChapterId = chapter.id;
        this.layoutChapterId = chapter.id;
        this.loadedChapters = [];
        this.virtualTotalHeight = 0;
        this.isLoadingNext = false;
        this.isLoadingPrev = false;
        this.nextChapterRetryAvailable = false;
        this.chapterList = [...filtered].sort((a, b) => a.number - b.number);

        if (saved.pageIndex != null) {
            this.pendingPageRestore = { pageIndex: saved.pageIndex, scrollOffset: saved.scrollOffset ?? 0 };
        } else {
            this.pendingPageRestore = null;
        }

        this.log.emit('reader-open', { mangaId: manga.id, chapterId: chapter.id, chapterNumber: chapter.number, hasRestore: true });

        try {
            const pages = await api.fetchChapterImages(manga.id, chapter.id, chapter.number, chapter.url);
            const proxiedPages = pages.map(p => ({
                ...p,
                url: api.imageProxyUrl(p.url, manga.id, chapter.id, chapter.number, chapter.url),
            }));
            this.error = null;
            this.loadedChapters = [{
                id: chapter.id,
                number: chapter.number,
                pages: proxiedPages,
                groupName: chapter.groupName,
                slotState: 'ready',
                estimatedHeight: this.estimateLoadedChapterHeight(proxiedPages, 0),
            }];
            this.loadedChapters = this.positionVirtualSlots(this.loadedChapters, chapter.id, 0, 0);
            this.scheduleChapterWarmup(manga, chapter.id);
            return true;
        } catch (e) {
            this.error = toLoadError(e);
            return false;
        }
    }

    trackVisiblePage(chapterId: string, pageIndex: number, scrollOffset: number, source: 'scroll' | 'close' = 'scroll', snapshot?: VisiblePageSnapshot): void {
        this.pageTracker.track(chapterId, pageIndex, scrollOffset);
        if (chapterId !== this.currentChapterId) {
            const prevChapterId = this.currentChapterId;
            this.currentChapterId = chapterId;
            this.manga.updateScrollTarget(chapterId, this.mangaEntryKey ?? undefined);
            this.log.emit('reader-chapter-change', {
                mangaId: this.activeMangaId,
                fromChapterId: prevChapterId,
                toChapterId: chapterId,
            });
        }
        if (snapshot || source === 'close') {
            const visible = snapshot ?? {
                chapterId,
                pageIndex,
                scrollOffset,
                rootScrollTop: 0,
                pageTop: 0,
                pageBottom: 0,
                probeY: 0,
            };
            this.log.emit('reader-visible-page', {
                source,
                mangaId: this.activeMangaId,
                currentChapterId: this.currentChapterId,
                visibleChapterId: visible.chapterId,
                pageIndex: visible.pageIndex,
                rootScrollTop: Math.round(visible.rootScrollTop),
                pageTop: Math.round(visible.pageTop),
                pageBottom: Math.round(visible.pageBottom),
                probeY: Math.round(visible.probeY),
            });
        }
        this.scheduleProgressSync(chapterId);
    }

    logCloseSnapshot(snapshot: VisiblePageSnapshot | null): void {
        this.log.emit('reader-close-snapshot', {
            mangaId: this.activeMangaId,
            currentChapterId: this.currentChapterId,
            visibleChapterId: snapshot?.chapterId ?? null,
            pageIndex: snapshot?.pageIndex,
            rootScrollTop: snapshot ? Math.round(snapshot.rootScrollTop) : undefined,
            pageTop: snapshot ? Math.round(snapshot.pageTop) : undefined,
            pageBottom: snapshot ? Math.round(snapshot.pageBottom) : undefined,
            loadedChapterIds: this.loadedChapters.map(ch => ch.id).join(','),
        });
    }

    syncChapterProgress(chapterId: string): void {
        const prevChapterId = this.currentChapterId;
        this.currentChapterId = chapterId;
        this.manga.updateScrollTarget(chapterId, this.mangaEntryKey ?? undefined);
        if (chapterId !== prevChapterId) {
            this.log.emit('reader-chapter-change', {
                mangaId: this.activeMangaId,
                fromChapterId: prevChapterId,
                toChapterId: chapterId,
            });
        }
        this.scheduleProgressSync(chapterId);
    }

    private scheduleProgressSync(chapterId: string): void {
        this.pageTracker.scheduleSync(chapterId, (cId, pageIndex, scrollOffset) => {
            const manga = this.manga.activeManga;
            if (!manga) return;
            const ch = this.chapterList.find(c => c.id === cId);
            if (ch) {
                const loaded = this.loadedChapters.find(lc => lc.id === cId);
                const pageCount = loaded?.pages.length;
                const progressData = { chapterId: cId, chapterNumber: ch.number, pageIndex, pageCount, scrollOffset };
                db.setProgress(manga.id, progressData);
                this.progress.update(manga.id, progressData);
                this.log.emit('progress-save', { source: 'scheduled', mangaId: manga.id, chapterId: cId, chapterNumber: ch.number, pageIndex, pageCount });
            }
        });
    }

    get pageRestoreTarget(): { pageIndex: number; scrollOffset: number } | null {
        return this.pendingPageRestore;
    }

    clearPageRestore(): void {
        this.pendingPageRestore = null;
    }

    clearHistorySync(): void {
        this.pageTracker.clearSync();
    }

    chapterScrollTop(chapterId: string, viewportWidth: number): number | null {
        return this.windowManager.chapterTop(
            this.chapterList,
            this.loadedChapters,
            chapterId,
            viewportWidth,
            (id, width) => this.estimateChapterHeight(id, width),
        );
    }

    get titleContext(): ReaderTitleContext | null {
        const chapterId = this.currentChapterId;
        if (!chapterId) return null;

        const loaded = this.loadedChapters.find(ch => ch.id === chapterId);
        if (loaded) {
            return {
                chapterNumber: loaded.number,
                groupName: loaded.groupName,
            };
        }

        const meta = this.chapterList.find(ch => ch.id === chapterId);
        if (!meta) return null;

        return {
            chapterNumber: meta.number,
            groupName: meta.groupName,
        };
    }

    get currentChapterMeta(): ChapterMeta | null {
        const chapterId = this.currentChapterId;
        if (!chapterId) return null;
        return this.chapterList.find(ch => ch.id === chapterId) ?? null;
    }

    private startChapterComments(pushView: boolean): boolean {
        const manga = this.manga.activeManga;
        const chapter = this.currentChapterMeta;
        if (!manga || !chapter) {
            this.log.emit('chapter-comments-error', {
                mangaId: this.activeMangaId,
                chapterId: this.currentChapterId ?? '',
                chapterNumber: 0,
                error: 'missing current chapter context',
            });
            return false;
        }

        const context: ChapterCommentsContext = {
            mangaId: manga.id,
            mangaTitle: manga.title,
            chapterId: chapter.id,
            chapterNumber: chapter.number,
            groupName: chapter.groupName,
        };
        this.chapterCommentsContext = context;
        this.chapterComments = [];
        this.chapterCommentsCount = 0;
        this.chapterCommentsStats = { ...EMPTY_COMMENT_STATS };
        this.chapterCommentsError = null;
        this.log.emit('chapter-comments-open', { mangaId: manga.id, chapterId: chapter.id, chapterNumber: chapter.number });
        if (pushView && this.ui.viewMode !== View.CHAPTER_COMMENTS) {
            this.ui.pushView(View.CHAPTER_COMMENTS);
        }
        void this.loadChapterComments(manga, chapter);
        return true;
    }

    prepareChapterComments(): boolean {
        return this.startChapterComments(false);
    }

    openChapterComments(): boolean {
        return this.startChapterComments(true);
    }

    commitPreparedChapterComments(): void {
        if (!this.chapterCommentsContext) return;
        if (this.ui.viewMode !== View.CHAPTER_COMMENTS) {
            this.ui.pushView(View.CHAPTER_COMMENTS);
        }
    }

    cancelPreparedChapterComments(): void {
        if (this.ui.viewMode === View.CHAPTER_COMMENTS) return;
        this.commentsEpoch++;
        this.commentsAbort?.abort();
        this.commentsAbort = null;
        this.chapterComments = [];
        this.chapterCommentsCount = 0;
        this.chapterCommentsStats = { ...EMPTY_COMMENT_STATS };
        this.isChapterCommentsLoading = false;
        this.chapterCommentsError = null;
        this.log.emit('chapter-comments-close', {
            mangaId: this.chapterCommentsContext?.mangaId ?? this.activeMangaId,
            chapterId: this.chapterCommentsContext?.chapterId ?? null,
        });
        this.chapterCommentsContext = null;
    }

    closeChapterComments(): void {
        this.commentsEpoch++;
        this.commentsAbort?.abort();
        this.commentsAbort = null;
        this.log.emit('chapter-comments-close', {
            mangaId: this.chapterCommentsContext?.mangaId ?? this.activeMangaId,
            chapterId: this.chapterCommentsContext?.chapterId ?? null,
        });
        this.ui.popView();
    }

    private async loadChapterComments(manga: Manga, chapter: ChapterMeta): Promise<void> {
        const epoch = ++this.commentsEpoch;
        this.commentsAbort?.abort();
        const controller = new AbortController();
        this.commentsAbort = controller;
        this.isChapterCommentsLoading = true;
        this.chapterCommentsError = null;
        const start = performance.now();
        this.log.emit('chapter-comments-start', { mangaId: manga.id, chapterId: chapter.id, chapterNumber: chapter.number });

        try {
            const result = await api.fetchChapterComments(manga.id, chapter, controller.signal);
            if (this.commentsEpoch !== epoch || controller.signal.aborted) return;
            this.chapterComments = result.comments;
            this.chapterCommentsCount = result.count;
            this.chapterCommentsStats = result.stats;
        } catch (e) {
            if (controller.signal.aborted || this.commentsEpoch !== epoch) return;
            const message = String((e as Error)?.message ?? e);
            this.chapterCommentsError = message;
            this.log.emit('chapter-comments-error', { mangaId: manga.id, chapterId: chapter.id, chapterNumber: chapter.number, error: message });
        } finally {
            if (this.commentsEpoch === epoch && !controller.signal.aborted) {
                this.isChapterCommentsLoading = false;
                this.log.emit('chapter-comments-done', { mangaId: manga.id, chapterId: chapter.id, chapterNumber: chapter.number, ms: Math.round(performance.now() - start) });
            }
        }
    }

    closeReader() {
        this.loadEpoch++;
        this.windowEpoch++;
        this.windowFetches.clear();
        this.lastViewportWidth = 0;
        this.lastViewportHeight = 0;
        this.measuredChapterHeights.clear();
        this.mangaAverageChapterHeight = null;
        this.commentsEpoch++;
        this.commentsAbort?.abort();
        this.commentsAbort = null;
        this.nextRetryWake = null;
        const mangaId = this.activeMangaId;
        const chapterId = this.currentChapterId;
        const backMangaId = this.manga.activeManga?.id ?? null;
        const backEntryKey = this.manga.activeEntryKey;

        this.pageTracker.flush((flushChapterId, pageIndex, scrollOffset) => {
            if (!mangaId) return;
            const ch = this.chapterList.find(c => c.id === flushChapterId);
            if (ch) {
                const loaded = this.loadedChapters.find(lc => lc.id === flushChapterId);
                const pageCount = loaded?.pages.length;
                const progressData = { chapterId: flushChapterId, chapterNumber: ch.number, pageIndex, pageCount, scrollOffset };
                db.setProgress(mangaId, progressData);
                this.progress.update(mangaId, progressData);
                this.log.emit('progress-save', { source: 'close', mangaId, chapterId: flushChapterId, chapterNumber: ch.number, pageIndex, pageCount });
            }
        });
        this.log.emit('reader-close', { mangaId, chapterId, backMangaId, backEntryKey });
        this.pageTracker.destroy();
        this.loadedChapters = [];
        this.virtualTotalHeight = 0;
        this.currentChapterId = null;
        this.layoutChapterId = null;
        this.chapterComments = [];
        this.chapterCommentsCount = 0;
        this.chapterCommentsStats = { ...EMPTY_COMMENT_STATS };
        this.isChapterCommentsLoading = false;
        this.chapterCommentsError = null;
        this.chapterCommentsContext = null;
        this.error = null;
        this.nextChapterRetryAvailable = false;
        this.mangaEntryKey = null;
        this.ui.popView();
    }

    reconcileReaderWindow(viewport: { scrollTop: number; clientHeight: number; clientWidth: number; chapterId?: string | null }, source: ReaderWindowSource): void {
        const manga = this.manga.activeManga;
        const layoutId = this.layoutChapterId ?? this.currentChapterId;
        if (!manga || !layoutId || this.chapterList.length === 0 || viewport.clientHeight <= 0) return;

        const direction = this.scrollDirection(viewport.scrollTop);
        this.lastWindowScrollTop = viewport.scrollTop;
        this.lastViewportWidth = viewport.clientWidth;
        this.lastViewportHeight = viewport.clientHeight;

        const radiusPx = viewport.clientHeight * READER_WINDOW_RADIUS_VIEWPORTS;
        const keepPx = viewport.clientHeight * READER_DOM_KEEP_RADIUS_VIEWPORTS;
        const plan = this.windowManager.plan({
            chapterList: this.chapterList,
            loadedChapters: this.loadedChapters,
            scrollTop: viewport.scrollTop,
            radiusPx,
            keepPx,
            viewportWidth: viewport.clientWidth,
            clientHeight: viewport.clientHeight,
            direction,
            estimateChapterHeight: (chapterId, viewportWidth) => this.estimateChapterHeight(chapterId, viewportWidth),
        });

        const beforeIds = this.loadedChapters.map(ch => ch.id);
        const nextSlots = plan.nextSlots;
        const afterIds = nextSlots.map(ch => ch.id);
        this.virtualTotalHeight = Math.max(plan.totalHeight, viewport.clientHeight);
        if (afterIds.join(',') !== beforeIds.join(',')) {
            this.loadedChapters = nextSlots;
            this.log.emit('reader-window-slots', {
                source,
                mangaId: manga.id,
                currentChapterId: plan.probeChapterId ?? layoutId,
                direction,
                radiusPx: Math.round(radiusPx),
                loadedChapterIds: afterIds.join(','),
                placeholderCount: nextSlots.filter(slot => slot.slotState !== 'ready').length,
            });
        }

        this.log.emit('reader-window-reconcile', {
            source,
            mangaId: manga.id,
            currentChapterId: plan.probeChapterId ?? layoutId,
            direction,
            scrollTop: Math.round(viewport.scrollTop),
            clientHeight: Math.round(viewport.clientHeight),
            wantedCount: plan.wantedIds.size,
            fetchingCount: this.windowFetches.size,
        });
        this.scheduleWindowFetches(manga, plan.candidates, source);
    }

    recordChapterMeasurements(measurements: Array<{ chapterId: string; height: number }>): void {
        if (measurements.length === 0) return;

        let total = 0;
        let count = 0;
        for (const measurement of measurements) {
            if (!Number.isFinite(measurement.height) || measurement.height <= 0) continue;
            this.measuredChapterHeights.set(measurement.chapterId, measurement.height);
            total += measurement.height;
            count++;
        }
        if (count === 0) return;

        const measuredAverage = total / count;
        this.mangaAverageChapterHeight = this.mangaAverageChapterHeight == null
            ? measuredAverage
            : this.mangaAverageChapterHeight * 0.7 + measuredAverage * 0.3;
    }

    private scrollDirection(scrollTop: number): ReaderScrollDirection {
        const delta = scrollTop - this.lastWindowScrollTop;
        if (Math.abs(delta) < 2) return 'idle';
        return delta > 0 ? 'down' : 'up';
    }

    private scheduleWindowFetches(manga: Manga, candidates: WindowCandidate[], source: ReaderWindowSource): void {
        const windowEpoch = this.windowEpoch;
        const loadEpoch = this.loadEpoch;
        const queued = candidates
            .filter(candidate => candidate.side !== 'current')
            .filter(candidate => {
                const slot = this.loadedChapters.find(ch => ch.id === candidate.chapter.id);
                return slot
                    && slot.slotState !== 'ready'
                    && !this.windowFetches.has(candidate.chapter.id);
            })
            .slice(0, 3);

        for (const candidate of queued) {
            this.windowFetches.add(candidate.chapter.id);
            this.markSlotLoading(candidate.chapter.id);
            this.log.emit('reader-window-fetch-start', {
                source,
                mangaId: manga.id,
                chapterId: candidate.chapter.id,
                chapterNumber: candidate.chapter.number,
                side: candidate.side,
                priority: Math.round(candidate.priority),
                distance: Math.round(candidate.distance),
                fetchingCount: this.windowFetches.size,
            });
            void this.fetchWindowChapter(manga, candidate, windowEpoch, loadEpoch, source);
        }
    }

    private markSlotLoading(chapterId: string): void {
        this.loadedChapters = this.loadedChapters.map(slot => (
            slot.id === chapterId && slot.slotState === 'placeholder'
                ? { ...slot, slotState: 'loading' }
                : slot
        ));
    }

    private async fetchWindowChapter(manga: Manga, candidate: WindowCandidate, windowEpoch: number, loadEpoch: number, source: ReaderWindowSource): Promise<void> {
        try {
            const result = await this.loadChapter({ manga, chapter: candidate.chapter });
            if (this.windowEpoch !== windowEpoch || this.loadEpoch !== loadEpoch || result.kind === 'stale') {
                this.log.emit('reader-window-fetch-stale', {
                    source,
                    mangaId: manga.id,
                    chapterId: candidate.chapter.id,
                    reason: 'epoch',
                });
                return;
            }
            if (result.kind === 'failed') {
                this.loadedChapters = this.loadedChapters.map(slot => (
                    slot.id === candidate.chapter.id ? { ...slot, slotState: 'placeholder' } : slot
                ));
                this.log.emit('reader-window-fetch-failed', {
                    source,
                    mangaId: manga.id,
                    chapterId: candidate.chapter.id,
                    error: String((result.error as Error)?.message ?? result.error),
                });
                return;
            }

            const index = this.loadedChapters.findIndex(slot => slot.id === result.chapter.id);
            if (index < 0) {
                this.log.emit('reader-window-fetch-stale', {
                    source,
                    mangaId: manga.id,
                    chapterId: candidate.chapter.id,
                    reason: 'slot-missing',
                });
                return;
            }

            const readyChapter: LoadedChapter = {
                ...result.chapter,
                slotState: 'ready',
                estimatedHeight: this.estimateLoadedChapterHeight(result.chapter.pages, candidate.viewportWidth),
            };

            this.applyReadyWindowChapter(manga, readyChapter, source, candidate.side === 'current' ? 'current' : 'window');
        } finally {
            this.windowFetches.delete(candidate.chapter.id);
        }
    }

    private applyReadyWindowChapter(
        manga: Manga,
        readyChapter: LoadedChapter,
        source: ReaderWindowSource,
        reason: 'current' | 'window',
    ): void {
        const index = this.loadedChapters.findIndex(slot => slot.id === readyChapter.id);
        if (index < 0) return;

        const previousHeight = this.loadedChapters[index].estimatedHeight ?? null;
        const estimatedHeight = readyChapter.estimatedHeight ?? 0;
        const positionedReadyChapter = {
            ...readyChapter,
            estimatedHeight,
            virtualHeight: estimatedHeight,
        };
        this.loadedChapters = this.loadedChapters.map(slot => slot.id === readyChapter.id ? positionedReadyChapter : slot);
        this.scheduleChapterWarmup(manga, readyChapter.id);
        this.log.emit('reader-window-height-delta', {
            source,
            mangaId: manga.id,
            chapterId: readyChapter.id,
            previousEstimatedHeight: previousHeight == null ? null : Math.round(previousHeight),
            estimatedHeight: Math.round(estimatedHeight),
            delta: previousHeight == null ? null : Math.round(estimatedHeight - previousHeight),
        });
        this.log.emit('reader-window-hydration-applied', {
            source,
            mangaId: manga.id,
            chapterId: readyChapter.id,
            chapterNumber: readyChapter.number,
            reason,
            currentChapterId: this.currentChapterId,
            currentVirtualTop: this.chapterScrollTop(this.layoutChapterId ?? readyChapter.id, this.layoutViewportWidth(readyChapter.pages[0]?.width ?? 0)),
            layoutViewportHeight: Math.round(this.layoutViewportHeight()),
        });
        this.log.emit('reader-window-fetch-ok', {
            source,
            mangaId: manga.id,
            chapterId: readyChapter.id,
            chapterNumber: readyChapter.number,
            pages: readyChapter.pages.length,
            previousEstimatedHeight: previousHeight == null ? null : Math.round(previousHeight),
            estimatedHeight: Math.round(estimatedHeight),
        });
    }

    private estimateChapterHeight(chapterId: string, viewportWidth: number): number {
        const measured = this.measuredChapterHeights.get(chapterId);
        if (measured) return measured;

        const loaded = this.loadedChapters.find(ch => ch.id === chapterId && ch.pages.length > 0);
        if (loaded) return this.estimateLoadedChapterHeight(loaded.pages, viewportWidth);

        return this.mangaAverageChapterHeight
            ?? this.averageLoadedChapterHeight(viewportWidth)
            ?? Math.round(viewportWidth * READER_FALLBACK_PAGE_ASPECT_RATIO * 24 + READER_CHAPTER_SEPARATOR_HEIGHT);
    }

    private positionVirtualSlots(slots: LoadedChapter[], _currentId: string, viewportWidth: number, clientHeight: number): LoadedChapter[] {
        if (slots.length === 0) {
            this.virtualTotalHeight = 0;
            return slots;
        }

        const plan = this.windowManager.plan({
            chapterList: this.chapterList,
            loadedChapters: slots,
            scrollTop: this.chapterScrollTop(_currentId, viewportWidth) ?? 0,
            radiusPx: Math.max(clientHeight, 1) * READER_WINDOW_RADIUS_VIEWPORTS,
            keepPx: Math.max(clientHeight, 1) * READER_DOM_KEEP_RADIUS_VIEWPORTS,
            viewportWidth,
            clientHeight: Math.max(clientHeight, 1),
            direction: 'idle',
            estimateChapterHeight: (chapterId, width) => this.estimateChapterHeight(chapterId, width),
        });
        this.virtualTotalHeight = plan.totalHeight;
        return plan.nextSlots;
    }

    private layoutViewportWidth(fallbackWidth = 0): number {
        return this.lastViewportWidth > 1 ? this.lastViewportWidth : fallbackWidth;
    }

    private layoutViewportHeight(): number {
        return this.lastViewportHeight > 1 ? this.lastViewportHeight : 0;
    }

    private averageLoadedChapterHeight(viewportWidth: number): number | null {
        const loaded = this.loadedChapters.filter(ch => ch.pages.length > 0);
        if (loaded.length === 0) return null;
        const total = loaded.reduce((sum, ch) => sum + this.estimateLoadedChapterHeight(ch.pages, viewportWidth), 0);
        return total / loaded.length;
    }

    private estimateLoadedChapterHeight(pages: LoadedChapter['pages'], viewportWidth: number): number {
        if (pages.length === 0) return Math.round(viewportWidth * READER_FALLBACK_PAGE_ASPECT_RATIO + READER_CHAPTER_SEPARATOR_HEIGHT);
        const width = viewportWidth > 1 ? viewportWidth : 390;
        const pageHeight = pages.reduce((sum, page) => {
            if (page.width && page.height) return sum + width * page.height / page.width;
            return sum + width * READER_FALLBACK_PAGE_ASPECT_RATIO;
        }, 0);
        return Math.round(pageHeight + READER_CHAPTER_SEPARATOR_HEIGHT);
    }

    private getAdjacent(chapterId: string, direction: 'next' | 'prev'): ChapterMeta | null {
        const idx = this.chapterList.findIndex(c => c.id === chapterId);
        if (idx === -1) return null;
        const targetIdx = direction === 'next' ? idx + 1 : idx - 1;
        return this.chapterList[targetIdx] ?? null;
    }

    private scheduleChapterWarmup(manga: Manga, centerChapterId: string): void {
        const idx = this.chapterList.findIndex(c => c.id === centerChapterId);
        if (idx === -1) return;

        const loadedIds = new Set(this.loadedChapters.map(ch => ch.id));
        const start = Math.max(0, idx - CHAPTER_WARM_PREV);
        const end = Math.min(this.chapterList.length - 1, idx + CHAPTER_WARM_NEXT);
        const chapters = this.chapterList
            .slice(start, end + 1)
            .filter(chapter => chapter.id !== centerChapterId && !loadedIds.has(chapter.id));

        api.prewarmChapterDetails(manga.id, chapters);
    }

    private async loadChapter(req: ChapterLoadRequest): Promise<ChapterLoadResult> {
        try {
            const pages = await api.fetchChapterImages(req.manga.id, req.chapter.id, req.chapter.number, req.chapter.url);
            const proxiedPages = pages.map(p => ({
                ...p,
                url: api.imageProxyUrl(p.url, req.manga.id, req.chapter.id, req.chapter.number, req.chapter.url),
            }));
            return {
                kind: 'loaded',
                chapter: {
                    id: req.chapter.id,
                    number: req.chapter.number,
                    pages: proxiedPages,
                    groupName: req.chapter.groupName,
                },
            };
        } catch (error) {
            return { kind: 'failed', error };
        }
    }

    private async loadChapterWithRetries(edge: ReaderEdge, req: ChapterLoadRequest, epoch: number): Promise<ChapterLoadResult> {
        let manualRetryUsed = false;

        for (let attempt = 0; attempt <= EDGE_LOAD_RETRY_DELAYS_MS.length; attempt++) {
            const result = await this.loadChapter(req);
            if (result.kind === 'loaded') return result;

            const canRetry =
                !manualRetryUsed &&
                attempt < EDGE_LOAD_RETRY_DELAYS_MS.length &&
                this.loadEpoch === epoch &&
                this.activeMangaId === req.manga.id &&
                !this.loadedChapters.some(c => c.id === req.chapter.id);

            if (!canRetry) return result;

            if (edge === 'next') {
                this.nextChapterRetryAvailable = true;
            }
            this.log.emit('reader-edge-retry', {
                edge,
                mangaId: req.manga.id,
                chapterId: req.chapter.id,
                attempt: attempt + 1,
                error: String((result.error as Error)?.message ?? result.error),
            });
            const waitResult = await this.waitForRetry(edge, EDGE_LOAD_RETRY_DELAYS_MS[attempt], epoch);
            if (waitResult === 'stale') return { kind: 'stale' };
            if (waitResult === 'manual') manualRetryUsed = true;
        }

        return { kind: 'failed', error: new Error('chapter load retry exhausted') };
    }

    private async waitForRetry(edge: ReaderEdge, ms: number, epoch: number): Promise<RetryWaitResult> {
        return await new Promise<RetryWaitResult>(resolve => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | null = null;

            const finish = (result: RetryWaitResult) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                if (edge === 'next' && this.nextRetryWake === wake) {
                    this.nextRetryWake = null;
                }
                resolve(this.loadEpoch === epoch ? result : 'stale');
            };

            const wake = () => finish('manual');

            if (edge === 'next') {
                this.nextRetryWake = wake;
            }

            timer = setTimeout(() => finish('timer'), ms);
        });
    }

    retryNextChapterNow(): void {
        if (!this.isLoadingNext || !this.nextChapterRetryAvailable) return;
        this.nextChapterRetryAvailable = false;
        this.nextRetryWake?.();
    }

    async appendNextChapter(): Promise<boolean> {
        if (this.isLoadingNext) {
            this.log.emit('reader-append-skipped', { reason: 'loading' });
            return false;
        }
        if (!this.currentChapterId) {
            this.log.emit('reader-append-skipped', { reason: 'loading' });
            return false;
        }
        const manga = this.manga.activeManga;
        if (!manga) {
            this.log.emit('reader-append-skipped', { reason: 'no-manga' });
            return false;
        }

        const lastLoaded = this.loadedChapters[this.loadedChapters.length - 1];
        if (!lastLoaded) {
            this.log.emit('reader-append-skipped', { reason: 'no-loaded' });
            return false;
        }

        const next = this.getAdjacent(lastLoaded.id, 'next');
        if (!next) {
            this.log.emit('reader-append-skipped', { reason: 'no-next' });
            return false;
        }
        if (this.loadedChapters.some(c => c.id === next.id)) {
            this.log.emit('reader-append-skipped', { reason: 'already-loaded' });
            return false;
        }

        const epoch = this.loadEpoch;
        this.isLoadingNext = true;
        this.nextChapterRetryAvailable = false;
        this.log.emit('reader-edge-load-start', {
            edge: 'next',
            mangaId: manga.id,
            targetChapterId: next.id,
            targetChapterNumber: next.number,
            currentChapterId: this.currentChapterId,
            firstLoadedChapterId: this.loadedChapters[0]?.id ?? null,
            lastLoadedChapterId: lastLoaded.id,
            loadedCount: this.loadedChapters.length,
        });
        try {
            const result = await this.loadChapterWithRetries('next', { manga, chapter: next }, epoch);
            if (result.kind === 'stale') return false;
            if (result.kind === 'failed') {
                this.log.emit('reader-append-failed', { mangaId: manga.id, chapterId: next.id, error: String((result.error as Error)?.message ?? result.error) });
                this.nextChapterRetryAvailable = true;
                this.toast.show(Msg.LOAD_NEXT_FAILED);
                return false;
            }
            if (this.loadEpoch !== epoch || this.loadedChapters.some(c => c.id === result.chapter.id)) return false;

            this.loadedChapters = this.positionVirtualSlots(
                [...this.loadedChapters, result.chapter],
                this.layoutChapterId ?? result.chapter.id,
                this.layoutViewportWidth(),
                this.layoutViewportHeight(),
            );
            this.nextChapterRetryAvailable = false;
            this.scheduleChapterWarmup(manga, result.chapter.id);
            this.log.emit('reader-append-ok', { mangaId: manga.id, chapterId: next.id, chapterNumber: next.number });
            return true;
        } catch (e) {
            this.log.emit('reader-append-failed', { mangaId: manga.id, chapterId: next.id, error: String((e as Error)?.message ?? e) });
            this.nextChapterRetryAvailable = true;
            this.toast.show(Msg.LOAD_NEXT_FAILED);
            return false;
        } finally {
            this.isLoadingNext = false;
        }
    }

    async prependPrevChapter(): Promise<LoadedChapter | null> {
        if (this.isLoadingPrev) {
            this.log.emit('reader-prepend-skipped', { reason: 'loading' });
            return null;
        }
        if (!this.currentChapterId) {
            this.log.emit('reader-prepend-skipped', { reason: 'loading' });
            return null;
        }
        const manga = this.manga.activeManga;
        if (!manga) {
            this.log.emit('reader-prepend-skipped', { reason: 'no-manga' });
            return null;
        }

        const firstLoaded = this.loadedChapters[0];
        if (!firstLoaded) {
            this.log.emit('reader-prepend-skipped', { reason: 'no-loaded' });
            return null;
        }

        const prev = this.getAdjacent(firstLoaded.id, 'prev');
        if (!prev) {
            this.log.emit('reader-prepend-skipped', { reason: 'no-prev' });
            return null;
        }
        if (this.loadedChapters.some(c => c.id === prev.id)) {
            this.log.emit('reader-prepend-skipped', { reason: 'already-loaded' });
            return null;
        }

        const epoch = this.loadEpoch;
        this.isLoadingPrev = true;
        this.log.emit('reader-edge-load-start', {
            edge: 'prev',
            mangaId: manga.id,
            targetChapterId: prev.id,
            targetChapterNumber: prev.number,
            currentChapterId: this.currentChapterId,
            firstLoadedChapterId: firstLoaded.id,
            lastLoadedChapterId: this.loadedChapters[this.loadedChapters.length - 1]?.id ?? null,
            loadedCount: this.loadedChapters.length,
        });
        try {
            const result = await this.loadChapterWithRetries('prev', { manga, chapter: prev }, epoch);
            if (result.kind === 'stale') return null;
            if (result.kind === 'failed') {
                this.log.emit('reader-prepend-failed', { mangaId: manga.id, chapterId: prev.id, error: String((result.error as Error)?.message ?? result.error) });
                this.toast.show(Msg.LOAD_PREV_FAILED);
                return null;
            }
            if (this.loadEpoch !== epoch || this.loadedChapters.some(c => c.id === result.chapter.id)) return null;

            const chapter = result.chapter;
            this.loadedChapters = this.positionVirtualSlots(
                [chapter, ...this.loadedChapters],
                this.layoutChapterId ?? chapter.id,
                this.layoutViewportWidth(),
                this.layoutViewportHeight(),
            );
            this.scheduleChapterWarmup(manga, chapter.id);
            this.log.emit('reader-prepend-ok', { mangaId: manga.id, chapterId: prev.id, chapterNumber: prev.number });
            return chapter;
        } catch (e) {
            this.log.emit('reader-prepend-failed', { mangaId: manga.id, chapterId: prev.id, error: String((e as Error)?.message ?? e) });
            this.toast.show(Msg.LOAD_PREV_FAILED);
            return null;
        } finally {
            this.isLoadingPrev = false;
        }
    }
}
