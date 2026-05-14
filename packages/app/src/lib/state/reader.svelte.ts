import type { Manga, ChapterMeta, LoadedChapter, MangaComment, MangaCommentStats, ReaderPageGeometry } from '../types.js';
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
const READER_PHYSICAL_BEFORE_PX = 200_000;
const READER_PHYSICAL_AFTER_PX = 200_000;
const READER_PHYSICAL_REBASE_MARGIN_PX = 80_000;
export type ReaderScrollActivity = 'settled' | 'idle' | 'scrolling' | 'programmatic';

type ReaderWindowReconcileResult = {
    frameEpoch: number;
    projectionEpoch: number;
    projectionChanged: boolean;
    physicalScrollTop: number;
};

type ReaderWindowFrame = {
    epoch: number;
    projectionEpoch: number;
    logicalScrollTop: number;
    physicalWindowStart: number;
    physicalScrollTop: number;
    physicalHeight: number;
    slots: LoadedChapter[];
};

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
    physicalWindowStart = $state(0);
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
    private pendingMeasuredChapterHeights = new Map<string, number>();
    private estimatedChapterHeights = new Map<string, number>();
    private heightRevision = 0;
    private mangaAverageChapterHeight: number | null = null;
    private lastWindowReconcileLogAt = 0;
    private lastWindowReconcileSignature = '';
    private readerWindowFrameEpoch = 0;
    private readerProjectionEpoch = 0;
    private readerWindowFrameSignature = '';
    private readerWindowFrame: ReaderWindowFrame | null = null;
    private chapterDataById = new Map<string, LoadedChapter>();
    private warmRequestedChapterIds = new Set<string>();
    private windowManager = new ReaderWindowManager();
    private pendingMangaScrollTargetChapterId: string | null = null;
    private scrollActivity: ReaderScrollActivity = 'settled';
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

    private resetWindowLayoutCache(): void {
        this.heightRevision++;
        this.windowManager.clear();
    }

    get windowFrameEpoch(): number {
        return this.readerWindowFrameEpoch;
    }

    get projectionEpoch(): number {
        return this.readerProjectionEpoch;
    }

    setScrollActivity(activity: ReaderScrollActivity, source: string): void {
        if (activity === this.scrollActivity) return;
        const previous = this.scrollActivity;
        this.scrollActivity = activity;
        this.log.emit('reader-scroll-activity', {
            mangaId: this.manga.activeManga?.id ?? this.activeMangaId,
            from: previous,
            to: activity,
            source,
        });
    }

    get isScrollActive(): boolean {
        return this.scrollActivity !== 'settled';
    }

    get isScrollSettled(): boolean {
        return this.scrollActivity === 'settled';
    }

    private plannerChapters(): LoadedChapter[] {
        return this.loadedChapters.map(slot => this.materializeFrameSlot(slot));
    }

    private materializeFrameSlots(slots: LoadedChapter[]): LoadedChapter[] {
        return slots.map(slot => this.materializeFrameSlot(slot));
    }

    private materializeFrameSlot(slot: LoadedChapter): LoadedChapter {
        const ready = this.chapterDataById.get(slot.id);
        if (!ready) return slot;
        const readyHeight = ready.estimatedHeight ?? slot.estimatedHeight ?? slot.virtualHeight;

        return {
            ...ready,
            slotState: 'ready',
            logicalTop: slot.logicalTop,
            logicalHeight: readyHeight ?? slot.logicalHeight,
            virtualTop: slot.virtualTop,
            virtualHeight: readyHeight,
            estimatedHeight: readyHeight,
        };
    }

    async openReader(manga: Manga, chapter: ChapterMeta, mangaEntryKey: string | null = this.manga.activeEntryKey) {
        this.loadEpoch++;
        this.windowEpoch++;
        this.windowFetches.clear();
        this.lastViewportWidth = 0;
        this.lastViewportHeight = 0;
        this.measuredChapterHeights.clear();
        this.pendingMeasuredChapterHeights.clear();
        this.estimatedChapterHeights.clear();
        this.resetWindowLayoutCache();
        this.mangaAverageChapterHeight = null;
        this.lastWindowReconcileLogAt = 0;
        this.lastWindowReconcileSignature = '';
        this.readerWindowFrameEpoch = 0;
        this.readerProjectionEpoch = 0;
        this.readerWindowFrameSignature = '';
        this.readerWindowFrame = null;
        this.chapterDataById.clear();
        this.warmRequestedChapterIds.clear();
        this.pendingMangaScrollTargetChapterId = null;
        this.scrollActivity = 'settled';
        this.nextRetryWake = null;
        this.activeMangaId = manga.id;
        this.mangaEntryKey = mangaEntryKey;
        this.currentChapterId = chapter.id;
        this.layoutChapterId = chapter.id;
        this.loadedChapters = [];
        this.virtualTotalHeight = 0;
        this.physicalWindowStart = 0;
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
            this.error = null;
            const readyChapter: LoadedChapter = {
                id: chapter.id,
                number: chapter.number,
                pages,
                groupName: chapter.groupName,
                slotState: 'ready',
                estimatedHeight: this.estimateLoadedChapterHeight(pages, 0),
            };
            this.chapterDataById.set(chapter.id, readyChapter);
            this.loadedChapters = [readyChapter];
            this.loadedChapters = this.positionVirtualSlots(this.loadedChapters, chapter.id, 0, 0);

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
        this.pendingMeasuredChapterHeights.clear();
        this.estimatedChapterHeights.clear();
        this.resetWindowLayoutCache();
        this.mangaAverageChapterHeight = null;
        this.lastWindowReconcileLogAt = 0;
        this.lastWindowReconcileSignature = '';
        this.readerWindowFrameEpoch = 0;
        this.readerProjectionEpoch = 0;
        this.readerWindowFrameSignature = '';
        this.readerWindowFrame = null;
        this.chapterDataById.clear();
        this.warmRequestedChapterIds.clear();
        this.pendingMangaScrollTargetChapterId = null;
        this.scrollActivity = 'settled';
        this.nextRetryWake = null;
        this.activeMangaId = manga.id;
        this.mangaEntryKey = this.manga.activeEntryKey;
        this.currentChapterId = chapter.id;
        this.layoutChapterId = chapter.id;
        this.loadedChapters = [];
        this.virtualTotalHeight = 0;
        this.physicalWindowStart = 0;
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
        this.commitMangaScrollTarget();

        try {
            const pages = await api.fetchChapterImages(manga.id, chapter.id, chapter.number, chapter.url);
            this.error = null;
            const readyChapter: LoadedChapter = {
                id: chapter.id,
                number: chapter.number,
                pages,
                groupName: chapter.groupName,
                slotState: 'ready',
                estimatedHeight: this.estimateLoadedChapterHeight(pages, 0),
            };
            this.chapterDataById.set(chapter.id, readyChapter);
            this.loadedChapters = [readyChapter];
            this.loadedChapters = this.positionVirtualSlots(this.loadedChapters, chapter.id, 0, 0);
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
            this.pendingMangaScrollTargetChapterId = chapterId;
            this.log.emit('reader-chapter-change', {
                mangaId: this.activeMangaId,
                fromChapterId: prevChapterId,
                toChapterId: chapterId,
            });
        }
        if (source === 'close') {
            this.pendingMangaScrollTargetChapterId = chapterId;
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
                selection: 'probe',
                ownerChapterId: null,
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
                selection: visible.selection,
                ownerChapterId: visible.ownerChapterId,
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
        this.pendingMangaScrollTargetChapterId = chapterId;
        if (chapterId !== prevChapterId) {
            this.log.emit('reader-chapter-change', {
                mangaId: this.activeMangaId,
                fromChapterId: prevChapterId,
                toChapterId: chapterId,
            });
        }
        this.scheduleProgressSync(chapterId);
    }

    private commitMangaScrollTarget(): void {
        const chapterId = this.pendingMangaScrollTargetChapterId ?? this.currentChapterId;
        if (!chapterId) return;
        this.manga.updateScrollTarget(chapterId, this.mangaEntryKey ?? undefined);
        this.pendingMangaScrollTargetChapterId = null;
    }

    prepareMangaBackTarget(): void {
        this.commitMangaScrollTarget();
    }

    private scheduleProgressSync(chapterId: string): void {
        this.pageTracker.scheduleSync(chapterId, (cId, pageIndex, scrollOffset) => {
            const manga = this.manga.activeManga;
            if (!manga) return;
            const ch = this.chapterList.find(c => c.id === cId);
            if (ch) {
                const loaded = this.chapterDataById.get(cId) ?? this.loadedChapters.find(lc => lc.id === cId);
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

    get pendingLayoutMeasurementCount(): number {
        return this.pendingMeasuredChapterHeights.size;
    }

    chapterScrollTop(chapterId: string, viewportWidth: number): number | null {
        const logicalTop = this.windowManager.chapterTop(
            this.chapterList,
            this.plannerChapters(),
            chapterId,
            viewportWidth,
            this.heightRevision,
            (id, width) => this.estimateChapterHeight(id, width),
        );
        return logicalTop == null ? null : Math.max(0, logicalTop - this.physicalWindowStart);
    }

    logicalChapterScrollTop(chapterId: string, viewportWidth: number): number | null {
        return this.windowManager.chapterTop(
            this.chapterList,
            this.plannerChapters(),
            chapterId,
            viewportWidth,
            this.heightRevision,
            (id, width) => this.estimateChapterHeight(id, width),
        );
    }

    pageGeometry(viewportWidth: number): ReaderPageGeometry[] {
        return this.windowManager.pageGeometry(
            this.chapterList,
            this.loadedChapters,
            viewportWidth,
            this.heightRevision,
            (id, width) => this.estimateChapterHeight(id, width),
            this.physicalWindowStart,
        );
    }

    primeViewportLayout(viewportWidth: number, clientHeight: number): void {
        const layoutId = this.layoutChapterId ?? this.currentChapterId;
        if (!layoutId || this.loadedChapters.length === 0 || viewportWidth <= 1 || clientHeight <= 0) return;

        this.lastViewportWidth = viewportWidth;
        this.lastViewportHeight = clientHeight;

        let changedCount = 0;
        let totalDelta = 0;
        const nextSlots = this.loadedChapters.map(slot => {
            if (slot.slotState !== 'ready' || slot.pages.length === 0) return slot;
            const estimatedHeight = this.estimateLoadedChapterHeight(slot.pages, viewportWidth);
            const previousHeight = Math.round(slot.virtualHeight ?? slot.estimatedHeight ?? estimatedHeight);
            const delta = estimatedHeight - previousHeight;
            this.estimatedChapterHeights.set(slot.id, estimatedHeight);
            const ready = this.chapterDataById.get(slot.id);
            if (ready) {
                this.chapterDataById.set(slot.id, { ...ready, estimatedHeight });
            }
            if (Math.abs(delta) > 2) {
                changedCount++;
                totalDelta += delta;
            }
            return {
                ...slot,
                estimatedHeight,
                virtualHeight: estimatedHeight,
            };
        });

        if (changedCount === 0) return;
        this.resetWindowLayoutCache();
        this.loadedChapters = this.positionVirtualSlots(nextSlots, layoutId, viewportWidth, clientHeight);
        this.log.emit('reader-layout-prime', {
            mangaId: this.manga.activeManga?.id ?? this.activeMangaId,
            chapterId: layoutId,
            viewportWidth: Math.round(viewportWidth),
            clientHeight: Math.round(clientHeight),
            changedCount,
            totalDelta: Math.round(totalDelta),
        });
    }

    get titleContext(): ReaderTitleContext | null {
        const chapterId = this.currentChapterId;
        if (!chapterId) return null;

        const loaded = this.chapterDataById.get(chapterId) ?? this.loadedChapters.find(ch => ch.id === chapterId);
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
            const commitStart = performance.now();
            this.chapterComments = result.comments;
            this.chapterCommentsCount = result.count;
            this.chapterCommentsStats = result.stats;
            this.log.emit('chapter-comments-commit', {
                mangaId: manga.id,
                chapterId: chapter.id,
                chapterNumber: chapter.number,
                mode: 'immediate',
                comments: result.comments.length,
                commitMs: Math.round(performance.now() - commitStart),
            });
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
        this.pendingMeasuredChapterHeights.clear();
        this.estimatedChapterHeights.clear();
        this.resetWindowLayoutCache();
        this.mangaAverageChapterHeight = null;
        this.lastWindowReconcileLogAt = 0;
        this.lastWindowReconcileSignature = '';
        this.readerWindowFrameEpoch = 0;
        this.readerProjectionEpoch = 0;
        this.readerWindowFrameSignature = '';
        this.readerWindowFrame = null;
        this.chapterDataById.clear();
        this.scrollActivity = 'settled';
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
                const loaded = this.chapterDataById.get(flushChapterId) ?? this.loadedChapters.find(lc => lc.id === flushChapterId);
                const pageCount = loaded?.pages.length;
                const progressData = { chapterId: flushChapterId, chapterNumber: ch.number, pageIndex, pageCount, scrollOffset };
                db.setProgress(mangaId, progressData);
                this.progress.update(mangaId, progressData);
                this.log.emit('progress-save', { source: 'close', mangaId, chapterId: flushChapterId, chapterNumber: ch.number, pageIndex, pageCount });
            }
        });
        this.commitMangaScrollTarget();
        this.log.emit('reader-close', { mangaId, chapterId, backMangaId, backEntryKey });
        this.pageTracker.destroy();
        this.loadedChapters = [];
        this.virtualTotalHeight = 0;
        this.physicalWindowStart = 0;
        this.warmRequestedChapterIds.clear();
        this.readerProjectionEpoch = 0;
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

    reconcileReaderWindow(viewport: { scrollTop: number; clientHeight: number; clientWidth: number; chapterId?: string | null; physicalWindowStart?: number; projectionEpoch?: number }, source: ReaderWindowSource): ReaderWindowReconcileResult | null {
        const manga = this.manga.activeManga;
        const layoutId = this.currentChapterId ?? this.layoutChapterId;
        if (!manga || !layoutId || this.chapterList.length === 0 || viewport.clientHeight <= 0) return null;

        const ownsPhysicalProjection = viewport.physicalWindowStart != null;
        const observedProjectionEpoch = viewport.projectionEpoch ?? this.readerProjectionEpoch;
        if (!ownsPhysicalProjection && observedProjectionEpoch !== this.readerProjectionEpoch) {
            const currentPhysicalScrollTop = this.readerWindowFrame?.physicalScrollTop ?? Math.max(0, this.lastWindowScrollTop - this.physicalWindowStart);
            this.log.emit('reader-stale-physical-observation', {
                source,
                mangaId: manga.id,
                currentChapterId: layoutId,
                observedProjectionEpoch,
                currentProjectionEpoch: this.readerProjectionEpoch,
                observedScrollTop: Math.round(viewport.scrollTop),
                currentPhysicalScrollTop: Math.round(currentPhysicalScrollTop),
                physicalWindowStart: Math.round(this.physicalWindowStart),
                frameEpoch: this.readerWindowFrameEpoch,
            });
            return {
                frameEpoch: this.readerWindowFrameEpoch,
                projectionEpoch: this.readerProjectionEpoch,
                projectionChanged: false,
                physicalScrollTop: currentPhysicalScrollTop,
            };
        }

        const physicalWindowStart = viewport.physicalWindowStart ?? this.physicalWindowStart;
        const logicalScrollTop = physicalWindowStart + viewport.scrollTop;
        const direction = this.scrollDirection(logicalScrollTop);
        this.lastWindowScrollTop = logicalScrollTop;
        this.lastViewportWidth = viewport.clientWidth;
        this.lastViewportHeight = viewport.clientHeight;
        const allowDestructiveProjection = viewport.physicalWindowStart != null;
        const nextPhysicalWindowStart = allowDestructiveProjection
            ? this.nextPhysicalWindowStart(logicalScrollTop, viewport.clientHeight, viewport.physicalWindowStart != null, physicalWindowStart)
            : physicalWindowStart;

        const radiusPx = viewport.clientHeight * READER_WINDOW_RADIUS_VIEWPORTS;
        const keepPx = viewport.clientHeight * READER_DOM_KEEP_RADIUS_VIEWPORTS;
        const plan = this.windowManager.plan({
            chapterList: this.chapterList,
            loadedChapters: this.plannerChapters(),
            logicalScrollTop,
            physicalWindowStart: nextPhysicalWindowStart,
            physicalBeforePx: READER_PHYSICAL_BEFORE_PX,
            physicalAfterPx: READER_PHYSICAL_AFTER_PX,
            radiusPx,
            keepPx,
            viewportWidth: viewport.clientWidth,
            clientHeight: viewport.clientHeight,
            direction,
            heightRevision: this.heightRevision,
            estimateChapterHeight: (chapterId, viewportWidth) => this.estimateChapterHeight(chapterId, viewportWidth),
            preserveLoadedSlots: !allowDestructiveProjection,
        });

        const nextSlots = plan.nextSlots;
        const afterIds = nextSlots.map(ch => ch.id);
        const frame = this.commitWindowFrame({
            source,
            mangaId: manga.id,
            currentChapterId: plan.probeChapterId ?? layoutId,
            direction,
            radiusPx,
            physicalWindowStart: plan.physicalWindowStart,
            physicalScrollTop: plan.physicalScrollTop,
            physicalHeight: Math.max(plan.physicalHeight, viewport.clientHeight),
            slots: nextSlots,
        });
        if (frame.renderChanged) {
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

        this.logWindowReconcile({
            source,
            mangaId: manga.id,
            currentChapterId: plan.probeChapterId ?? layoutId,
            direction,
            scrollTop: Math.round(viewport.scrollTop),
            logicalScrollTop: Math.round(plan.logicalScrollTop),
            physicalWindowStart: Math.round(plan.physicalWindowStart),
            projectionEpoch: frame.projectionEpoch,
            physicalHeight: Math.round(plan.physicalHeight),
            clientHeight: Math.round(viewport.clientHeight),
            wantedCount: plan.wantedIds.size,
            fetchingCount: this.windowFetches.size,
            loadedChapterIds: afterIds.join(','),
            placeholderCount: nextSlots.filter(slot => slot.slotState !== 'ready').length,
        });
        if (!allowDestructiveProjection) {
            const currentPhysicalScrollTop = logicalScrollTop - physicalWindowStart;
            const physicalHeight = READER_PHYSICAL_BEFORE_PX + viewport.clientHeight + READER_PHYSICAL_AFTER_PX;
            const nearTop = currentPhysicalScrollTop < READER_PHYSICAL_REBASE_MARGIN_PX;
            const nearBottom = currentPhysicalScrollTop > physicalHeight - viewport.clientHeight - READER_PHYSICAL_REBASE_MARGIN_PX;
            if (nearTop || nearBottom) {
                this.log.emit('reader-rebase-deferred', {
                    source,
                    mangaId: manga.id,
                    activity: this.scrollActivity,
                    edge: nearTop ? 'top' : 'bottom',
                    currentPhysicalScrollTop: Math.round(currentPhysicalScrollTop),
                    physicalWindowStart: Math.round(physicalWindowStart),
                    physicalHeight: Math.round(physicalHeight),
                    clientHeight: Math.round(viewport.clientHeight),
                });
            }
        }
        this.schedulePhysicalWindowWarmup(manga, plan.warmCandidates, source, direction);
        this.scheduleWindowFetches(manga, plan.candidates, source);
        return {
            frameEpoch: frame.epoch,
            projectionEpoch: frame.projectionEpoch,
            projectionChanged: frame.projectionChanged,
            physicalScrollTop: frame.physicalScrollTop,
        };
    }

    physicalScrollTopForLogical(logicalScrollTop: number, clientHeight: number): number {
        return this.physicalTargetForLogical(logicalScrollTop, clientHeight).scrollTop;
    }

    physicalTargetForLogical(logicalScrollTop: number, clientHeight: number): { physicalWindowStart: number; scrollTop: number } {
        const physicalWindowStart = this.nextPhysicalWindowStart(logicalScrollTop, clientHeight, true);
        return {
            physicalWindowStart,
            scrollTop: Math.max(0, logicalScrollTop - physicalWindowStart),
        };
    }

    rebaseTargetIfNeeded(physicalScrollTop: number, clientHeight: number): { edge: ReaderEdge; physicalWindowStart: number; scrollTop: number } | null {
        if (clientHeight <= 0) return null;
        const logicalScrollTop = this.physicalWindowStart + physicalScrollTop;
        const physicalHeight = READER_PHYSICAL_BEFORE_PX + clientHeight + READER_PHYSICAL_AFTER_PX;
        const nearTop = physicalScrollTop < READER_PHYSICAL_REBASE_MARGIN_PX;
        const nearBottom = physicalScrollTop > physicalHeight - clientHeight - READER_PHYSICAL_REBASE_MARGIN_PX;
        if (!nearTop && !nearBottom) return null;
        const target = this.physicalTargetForLogical(logicalScrollTop, clientHeight);
        if (Math.abs(target.scrollTop - physicalScrollTop) <= 1 && Math.abs(target.physicalWindowStart - this.physicalWindowStart) <= 1) return null;
        return {
            edge: nearTop ? 'prev' : 'next',
            ...target,
        };
    }

    private nextPhysicalWindowStart(logicalScrollTop: number, clientHeight: number, forceCenter = false, currentWindowStart = this.physicalWindowStart): number {
        const currentPhysicalScrollTop = logicalScrollTop - currentWindowStart;
        const physicalHeight = READER_PHYSICAL_BEFORE_PX + clientHeight + READER_PHYSICAL_AFTER_PX;
        const tooNearTop = currentPhysicalScrollTop < READER_PHYSICAL_REBASE_MARGIN_PX;
        const tooNearBottom = currentPhysicalScrollTop > physicalHeight - clientHeight - READER_PHYSICAL_REBASE_MARGIN_PX;
        if (!forceCenter && !tooNearTop && !tooNearBottom) return currentWindowStart;
        return Math.max(0, logicalScrollTop - READER_PHYSICAL_BEFORE_PX);
    }

    private commitWindowFrame({
        source,
        mangaId,
        currentChapterId,
        direction,
        radiusPx,
        physicalWindowStart,
        physicalScrollTop,
        physicalHeight,
        slots,
    }: {
        source: ReaderWindowSource;
        mangaId: string;
        currentChapterId: string;
        direction: ReaderScrollDirection;
        radiusPx: number;
        physicalWindowStart: number;
        physicalScrollTop: number;
        physicalHeight: number;
        slots: LoadedChapter[];
    }): { epoch: number; projectionEpoch: number; projectionChanged: boolean; renderChanged: boolean; physicalScrollTop: number } {
        const renderSlots = this.materializeFrameSlots(slots);
        const slotSignature = this.windowSlotSignature(renderSlots);
        const frameSignature = [
            Math.round(physicalWindowStart),
            Math.round(physicalHeight),
            slotSignature,
        ].join('|');
        const previousSlotSignature = this.windowSlotSignature(this.loadedChapters);
        const slotsChanged = slotSignature !== previousSlotSignature;
        const frameChanged = frameSignature !== this.readerWindowFrameSignature;

        if (!frameChanged) {
            return {
                epoch: this.readerWindowFrameEpoch,
                projectionEpoch: this.readerProjectionEpoch,
                projectionChanged: false,
                renderChanged: false,
                physicalScrollTop,
            };
        }

        const previousPhysicalWindowStart = this.physicalWindowStart;
        const previousPhysicalHeight = this.virtualTotalHeight;
        const projectionChanged = Math.round(physicalWindowStart) !== Math.round(previousPhysicalWindowStart);
        if (projectionChanged) {
            this.readerProjectionEpoch++;
        }
        this.physicalWindowStart = physicalWindowStart;
        this.virtualTotalHeight = physicalHeight;
        this.loadedChapters = renderSlots;
        this.readerWindowFrameSignature = frameSignature;
        this.readerWindowFrameEpoch++;
        this.readerWindowFrame = {
            epoch: this.readerWindowFrameEpoch,
            projectionEpoch: this.readerProjectionEpoch,
            logicalScrollTop: physicalWindowStart + physicalScrollTop,
            physicalWindowStart,
            physicalScrollTop,
            physicalHeight,
            slots: renderSlots,
        };

        this.log.emit('reader-window-frame', {
            source,
            mangaId,
            currentChapterId,
            epoch: this.readerWindowFrameEpoch,
            projectionEpoch: this.readerProjectionEpoch,
            direction,
            radiusPx: Math.round(radiusPx),
            physicalWindowStart: Math.round(physicalWindowStart),
            physicalScrollTop: Math.round(physicalScrollTop),
            physicalStartDelta: Math.round(physicalWindowStart - previousPhysicalWindowStart),
            physicalHeight: Math.round(physicalHeight),
            physicalHeightDelta: Math.round(physicalHeight - previousPhysicalHeight),
            slotsChanged,
            loadedChapterIds: renderSlots.map(slot => slot.id).join(','),
            slotRanges: this.windowSlotRanges(renderSlots),
            placeholderCount: renderSlots.filter(slot => slot.slotState !== 'ready').length,
        });

        return {
            epoch: this.readerWindowFrameEpoch,
            projectionEpoch: this.readerProjectionEpoch,
            projectionChanged,
            renderChanged: slotsChanged,
            physicalScrollTop,
        };
    }

    private windowSlotSignature(slots: LoadedChapter[]): string {
        return slots
            .map(slot => [
                slot.id,
                Math.round(slot.virtualTop ?? 0),
                Math.round(slot.virtualHeight ?? slot.estimatedHeight ?? 0),
                slot.slotState ?? 'ready',
                slot.pages.length,
            ].join(':'))
            .join(',');
    }

    private windowSlotRanges(slots: LoadedChapter[]): string {
        return slots
            .slice(0, 8)
            .map(slot => {
                const top = Math.round(slot.virtualTop ?? 0);
                const height = Math.round(slot.virtualHeight ?? slot.estimatedHeight ?? 0);
                return `${slot.id}:${top}-${top + height}:${slot.slotState ?? 'ready'}:${slot.pages.length}`;
            })
            .join('|');
    }

    private logWindowReconcile(data: {
        source: ReaderWindowSource;
        mangaId: string;
        currentChapterId: string;
        direction: ReaderScrollDirection;
        scrollTop: number;
        logicalScrollTop: number;
        physicalWindowStart: number;
        projectionEpoch: number;
        physicalHeight: number;
        clientHeight: number;
        wantedCount: number;
        fetchingCount: number;
        loadedChapterIds: string;
        placeholderCount: number;
    }): void {
        const signature = [
            data.currentChapterId,
            data.direction,
            data.wantedCount,
            data.fetchingCount,
            data.loadedChapterIds,
            data.placeholderCount,
        ].join(':');
        const now = performance.now();
        const changed = signature !== this.lastWindowReconcileSignature;
        const shouldLog = data.source !== 'scroll' || changed || data.fetchingCount > 0 || now - this.lastWindowReconcileLogAt > 2_000;
        if (!shouldLog) return;

        this.lastWindowReconcileLogAt = now;
        this.lastWindowReconcileSignature = signature;
        this.log.emit('reader-window-reconcile', {
            source: data.source,
            mangaId: data.mangaId,
            currentChapterId: data.currentChapterId,
            direction: data.direction,
            scrollTop: data.scrollTop,
            logicalScrollTop: data.logicalScrollTop,
            physicalWindowStart: data.physicalWindowStart,
            projectionEpoch: data.projectionEpoch,
            physicalHeight: data.physicalHeight,
            clientHeight: data.clientHeight,
            wantedCount: data.wantedCount,
            fetchingCount: data.fetchingCount,
        });
    }

    recordChapterMeasurements(measurements: Array<{ chapterId: string; contentHeight: number; slotHeight: number }>): void {
        if (measurements.length === 0) return;

        let total = 0;
        let count = 0;
        for (const measurement of measurements) {
            if (!Number.isFinite(measurement.contentHeight) || measurement.contentHeight <= 0) continue;
            const contentHeight = Math.max(1, Math.round(measurement.contentHeight));
            const slotHeight = Math.max(1, Math.round(measurement.slotHeight));
            this.pendingMeasuredChapterHeights.set(measurement.chapterId, contentHeight);
            total += contentHeight;
            count++;
            const delta = contentHeight - slotHeight;
            if (Math.abs(delta) > 2) {
                this.log.emit('reader-layout-measurement', {
                    mangaId: this.manga.activeManga?.id ?? this.activeMangaId,
                    chapterId: measurement.chapterId,
                    contentHeight,
                    slotHeight,
                    delta,
                });
            }
        }
        if (count === 0) return;

        const measuredAverage = total / count;
        this.mangaAverageChapterHeight = this.mangaAverageChapterHeight == null
            ? measuredAverage
            : this.mangaAverageChapterHeight * 0.7 + measuredAverage * 0.3;
        this.resetWindowLayoutCache();
    }

    promotePendingMeasurements(anchorKey: string | null): { changed: boolean; changedCount: number; totalDelta: number } {
        if (this.pendingMeasuredChapterHeights.size === 0) return { changed: false, changedCount: 0, totalDelta: 0 };

        const pending = new Map(this.pendingMeasuredChapterHeights);
        this.pendingMeasuredChapterHeights.clear();

        let changedCount = 0;
        let totalDelta = 0;
        const nextChapters = this.loadedChapters.map(slot => {
            const measuredHeight = pending.get(slot.id);
            if (!measuredHeight || slot.slotState !== 'ready') return slot;
            const oldHeight = Math.max(1, Math.round(slot.virtualHeight ?? slot.estimatedHeight ?? measuredHeight));
            const delta = measuredHeight - oldHeight;
            this.measuredChapterHeights.set(slot.id, measuredHeight);
            if (Math.abs(delta) <= 2) return slot;
            changedCount++;
            totalDelta += delta;
            this.estimatedChapterHeights.set(slot.id, measuredHeight);
            const ready = this.chapterDataById.get(slot.id);
            if (ready) {
                this.chapterDataById.set(slot.id, { ...ready, estimatedHeight: measuredHeight });
            }
            return {
                ...slot,
                estimatedHeight: measuredHeight,
                virtualHeight: measuredHeight,
            };
        });

        if (changedCount === 0) return { changed: false, changedCount: 0, totalDelta: 0 };
        this.resetWindowLayoutCache();
        this.loadedChapters = this.positionExistingVirtualSlots(nextChapters, this.layoutViewportWidth());
        this.log.emit('reader-layout-idle-promote', {
            mangaId: this.manga.activeManga?.id ?? this.activeMangaId,
            changedCount,
            totalDelta: Math.round(totalDelta),
            anchorKey,
        });
        return { changed: true, changedCount, totalDelta };
    }

    private positionExistingVirtualSlots(slots: LoadedChapter[], viewportWidth: number): LoadedChapter[] {
        if (slots.length === 0 || this.chapterList.length === 0) return slots;
        const byId = new Map(slots.map(slot => [slot.id, slot]));
        let top = 0;
        const positioned = new Map<string, LoadedChapter>();

        for (const chapter of this.chapterList) {
            const slot = byId.get(chapter.id);
            const height = Math.max(1, slot?.virtualHeight ?? slot?.estimatedHeight ?? this.estimateChapterHeight(chapter.id, viewportWidth));
            if (slot) {
                positioned.set(slot.id, {
                    ...slot,
                    estimatedHeight: height,
                    logicalTop: top,
                    logicalHeight: height,
                    virtualTop: top - this.physicalWindowStart,
                    virtualHeight: height,
                });
            }
            top += height;
        }

        const positionedSlots = slots.map(slot => positioned.get(slot.id) ?? slot);
        const physicalHeight = Math.max(this.virtualTotalHeight, READER_PHYSICAL_BEFORE_PX + this.layoutViewportHeight() + READER_PHYSICAL_AFTER_PX);
        const frame = this.commitWindowFrame({
            source: 'visible',
            mangaId: this.activeMangaId,
            currentChapterId: this.currentChapterId ?? this.layoutChapterId ?? positionedSlots[0]?.id ?? '',
            direction: 'idle',
            radiusPx: this.layoutViewportHeight() * READER_WINDOW_RADIUS_VIEWPORTS,
            physicalWindowStart: this.physicalWindowStart,
            physicalScrollTop: Math.max(0, this.lastWindowScrollTop - this.physicalWindowStart),
            physicalHeight,
            slots: positionedSlots,
        });
        return frame.renderChanged ? this.loadedChapters : this.materializeFrameSlots(positionedSlots);
    }

    private scrollDirection(scrollTop: number): ReaderScrollDirection {
        const delta = scrollTop - this.lastWindowScrollTop;
        if (Math.abs(delta) < 2) return 'idle';
        return delta > 0 ? 'down' : 'up';
    }

    private schedulePhysicalWindowWarmup(
        manga: Manga,
        candidates: WindowCandidate[],
        source: ReaderWindowSource,
        direction: ReaderScrollDirection,
    ): void {
        let skippedReady = 0;
        let skippedInFlight = 0;
        let skippedRequested = 0;
        const chapters: ChapterMeta[] = [];

        for (const candidate of candidates) {
            const chapterId = candidate.chapter.id;
            const ready = this.chapterDataById.has(chapterId)
                || this.loadedChapters.some(slot => slot.id === chapterId && slot.slotState === 'ready' && slot.pages.length > 0);
            if (ready) {
                skippedReady++;
                continue;
            }
            if (this.windowFetches.has(chapterId)) {
                skippedInFlight++;
                continue;
            }
            if (this.warmRequestedChapterIds.has(chapterId)) {
                skippedRequested++;
                continue;
            }
            this.warmRequestedChapterIds.add(chapterId);
            chapters.push(candidate.chapter);
        }

        if (chapters.length === 0) return;

        this.log.emit('reader-cache-warmup', {
            mangaId: manga.id,
            source,
            direction,
            requested: chapters.length,
            skippedReady,
            skippedInFlight,
            skippedRequested,
            chapterIds: chapters.map(chapter => chapter.id).join(','),
        });
        api.warmChapterImages(manga.id, chapters, 'interactive');
    }

    private scheduleWindowFetches(manga: Manga, candidates: WindowCandidate[], source: ReaderWindowSource): void {
        const windowEpoch = this.windowEpoch;
        const loadEpoch = this.loadEpoch;
        const queued = candidates
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

        const previousSlot = this.loadedChapters[index];
        const previousHeight = previousSlot.estimatedHeight ?? null;
        const reservedHeight = previousSlot.virtualHeight ?? previousSlot.estimatedHeight ?? readyChapter.estimatedHeight ?? 0;
        const estimatedHeight = readyChapter.estimatedHeight ?? 0;
        this.estimatedChapterHeights.set(readyChapter.id, estimatedHeight);
        this.resetWindowLayoutCache();
        const cachedReadyChapter = {
            ...readyChapter,
            estimatedHeight,
        };
        this.chapterDataById.set(readyChapter.id, cachedReadyChapter);
        const positionedReadyChapter = this.materializeFrameSlot({
            ...previousSlot,
            slotState: 'ready',
            estimatedHeight,
            virtualHeight: estimatedHeight,
        });
        const nextSlots = this.loadedChapters.map(slot => slot.id === readyChapter.id ? positionedReadyChapter : slot);
        this.commitWindowFrame({
            source,
            mangaId: manga.id,
            currentChapterId: this.currentChapterId ?? this.layoutChapterId ?? readyChapter.id,
            direction: 'idle',
            radiusPx: this.layoutViewportHeight() * READER_WINDOW_RADIUS_VIEWPORTS,
            physicalWindowStart: this.physicalWindowStart,
            physicalScrollTop: Math.max(0, this.lastWindowScrollTop - this.physicalWindowStart),
            physicalHeight: this.virtualTotalHeight,
            slots: nextSlots,
        });
        this.log.emit('reader-window-height-delta', {
            source,
            mangaId: manga.id,
            chapterId: readyChapter.id,
            previousEstimatedHeight: previousHeight == null ? null : Math.round(previousHeight),
            reservedHeight: Math.round(reservedHeight),
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
            currentVirtualTop: this.chapterScrollTop(this.currentChapterId ?? this.layoutChapterId ?? readyChapter.id, this.layoutViewportWidth(readyChapter.pages[0]?.width ?? 0)),
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
        const pinned = this.estimatedChapterHeights.get(chapterId);
        if (pinned) return pinned;

        const measured = this.measuredChapterHeights.get(chapterId);
        if (measured) {
            this.estimatedChapterHeights.set(chapterId, measured);
            return measured;
        }

        const loaded = this.chapterDataById.get(chapterId) ?? this.loadedChapters.find(ch => ch.id === chapterId && ch.pages.length > 0);
        if (loaded) {
            const height = loaded.estimatedHeight ?? this.estimateLoadedChapterHeight(loaded.pages, viewportWidth);
            this.estimatedChapterHeights.set(chapterId, height);
            return height;
        }

        const height = this.mangaAverageChapterHeight
            ?? this.averageLoadedChapterHeight(viewportWidth)
            ?? Math.round(viewportWidth * READER_FALLBACK_PAGE_ASPECT_RATIO * 24 + READER_CHAPTER_SEPARATOR_HEIGHT);
        this.estimatedChapterHeights.set(chapterId, height);
        return height;
    }

    private positionVirtualSlots(slots: LoadedChapter[], _currentId: string, viewportWidth: number, clientHeight: number): LoadedChapter[] {
        if (slots.length === 0) {
            this.virtualTotalHeight = 0;
            this.readerWindowFrame = null;
            return slots;
        }

        const plannerSlots = slots.map(slot => this.materializeFrameSlot(slot));
        const logicalScrollTop = this.windowManager.chapterTop(
            this.chapterList,
            plannerSlots,
            _currentId,
            viewportWidth,
            this.heightRevision,
            (chapterId, width) => this.estimateChapterHeight(chapterId, width),
        ) ?? 0;
        const physicalWindowStart = this.nextPhysicalWindowStart(logicalScrollTop, Math.max(clientHeight, 1), true);
        const plan = this.windowManager.plan({
            chapterList: this.chapterList,
            loadedChapters: plannerSlots,
            logicalScrollTop,
            physicalWindowStart,
            physicalBeforePx: READER_PHYSICAL_BEFORE_PX,
            physicalAfterPx: READER_PHYSICAL_AFTER_PX,
            radiusPx: Math.max(clientHeight, 1) * READER_WINDOW_RADIUS_VIEWPORTS,
            keepPx: Math.max(clientHeight, 1) * READER_DOM_KEEP_RADIUS_VIEWPORTS,
            viewportWidth,
            clientHeight: Math.max(clientHeight, 1),
            direction: 'idle',
            heightRevision: this.heightRevision,
            estimateChapterHeight: (chapterId, width) => this.estimateChapterHeight(chapterId, width),
        });
        const frame = this.commitWindowFrame({
            source: 'initial',
            mangaId: this.activeMangaId,
            currentChapterId: plan.probeChapterId ?? _currentId,
            direction: 'idle',
            radiusPx: Math.max(clientHeight, 1) * READER_WINDOW_RADIUS_VIEWPORTS,
            physicalWindowStart: plan.physicalWindowStart,
            physicalScrollTop: plan.physicalScrollTop,
            physicalHeight: plan.physicalHeight,
            slots: plan.nextSlots,
        });
        return frame.renderChanged ? this.loadedChapters : this.materializeFrameSlots(plan.nextSlots);
    }

    private layoutViewportWidth(fallbackWidth = 0): number {
        return this.lastViewportWidth > 1 ? this.lastViewportWidth : fallbackWidth;
    }

    private layoutViewportHeight(): number {
        return this.lastViewportHeight > 1 ? this.lastViewportHeight : 0;
    }

    private averageLoadedChapterHeight(viewportWidth: number): number | null {
        const loaded = this.plannerChapters().filter(ch => ch.pages.length > 0);
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

    private async loadChapter(req: ChapterLoadRequest): Promise<ChapterLoadResult> {
        try {
            const pages = await api.fetchChapterImages(req.manga.id, req.chapter.id, req.chapter.number, req.chapter.url);
            return {
                kind: 'loaded',
                chapter: {
                    id: req.chapter.id,
                    number: req.chapter.number,
                    pages,
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
            this.chapterDataById.set(result.chapter.id, {
                ...result.chapter,
                slotState: 'ready',
                estimatedHeight: this.estimateLoadedChapterHeight(result.chapter.pages, this.layoutViewportWidth()),
            });

            this.loadedChapters = this.positionVirtualSlots(
                [...this.loadedChapters, result.chapter],
                this.layoutChapterId ?? result.chapter.id,
                this.layoutViewportWidth(),
                this.layoutViewportHeight(),
            );
            this.nextChapterRetryAvailable = false;
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
            this.chapterDataById.set(chapter.id, {
                ...chapter,
                slotState: 'ready',
                estimatedHeight: this.estimateLoadedChapterHeight(chapter.pages, this.layoutViewportWidth()),
            });
            this.loadedChapters = this.positionVirtualSlots(
                [chapter, ...this.loadedChapters],
                this.layoutChapterId ?? chapter.id,
                this.layoutViewportWidth(),
                this.layoutViewportHeight(),
            );
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
