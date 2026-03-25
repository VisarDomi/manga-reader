import type { Manga, ChapterMeta, LoadedChapter } from '../types.js';
import { View } from '../logic.js';
import { Msg } from '../messages.js';
import * as api from '../services/api.js';
import * as db from '../services/db.js';
import type { LogService } from '../services/LogService.js';
import { PageTracker } from '../services/PageTracker.js';
import type { UIState } from './ui.svelte.js';
import type { MangaState } from './manga.svelte.js';
import type { ProgressState } from './progress.svelte.js';
import type { ToastState } from './toast.svelte.js';
import { type LoadError, toLoadError } from './errors.js';

export class ReaderState {
    loadedChapters = $state<LoadedChapter[]>([]);
    currentChapterId = $state<string | null>(null);
    error = $state<LoadError | null>(null);
    isLoadingNext = $state(false);
    isLoadingPrev = $state(false);
    pendingPageRestore = $state<{ pageIndex: number; scrollOffset: number } | null>(null);
    private activeMangaId = '';
    /** The filtered+deduped+sorted chapter list from manga details. Reader navigates only within this list. */
    private chapterList: ChapterMeta[] = [];
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

    async openReader(manga: Manga, chapter: ChapterMeta) {
        this.activeMangaId = manga.id;
        this.currentChapterId = chapter.id;
        this.loadedChapters = [];
        this.isLoadingNext = false;
        this.isLoadingPrev = false;
        // Store sorted ascending (ch1, ch2, ch3, ...) for index-based navigation
        this.chapterList = [...this.manga.filteredChapters].sort((a, b) => a.number - b.number);

        // Check if reopening the same chapter — restore page position
        const saved = this.progress.get(manga.id);
        if (saved && saved.chapterId === chapter.id && saved.pageIndex != null) {
            this.pendingPageRestore = { pageIndex: saved.pageIndex, scrollOffset: saved.scrollOffset ?? 0 };
        } else {
            this.pendingPageRestore = null;
        }

        this.ui.pushView(View.READER);

        try {
            const pages = await api.fetchChapterImages(manga.id, chapter.id, chapter.number);
            const proxiedPages = pages.map(p => ({
                ...p,
                url: api.imageProxyUrl(p.url, manga.id, chapter.id, chapter.number),
            }));
            this.error = null;
            this.loadedChapters = [{
                id: chapter.id,
                number: chapter.number,
                pages: proxiedPages,
                groupName: chapter.groupName,
            }];

            // Save progress (local + in-memory)
            const progressData = { chapterId: chapter.id, chapterNumber: chapter.number };
            db.setProgress(manga.id, progressData);
            this.progress.update(manga.id, progressData);
        } catch (e) {
            this.error = toLoadError(e);
        }
    }

    /**
     * Restore reader state without pushing view (used by session restore).
     * Uses saved progress from IDB to determine which chapter/page to load.
     * Returns true if restoration succeeded.
     */
    async restoreReader(manga: Manga): Promise<boolean> {
        const saved = this.progress.get(manga.id);
        if (!saved) return false;

        const filtered = this.manga.filteredChapters;
        const chapter = filtered.find(c => c.id === saved.chapterId);
        if (!chapter) return false;

        this.activeMangaId = manga.id;
        this.currentChapterId = chapter.id;
        this.loadedChapters = [];
        this.isLoadingNext = false;
        this.isLoadingPrev = false;
        this.chapterList = [...filtered].sort((a, b) => a.number - b.number);

        if (saved.pageIndex != null) {
            this.pendingPageRestore = { pageIndex: saved.pageIndex, scrollOffset: saved.scrollOffset ?? 0 };
        } else {
            this.pendingPageRestore = null;
        }

        try {
            const pages = await api.fetchChapterImages(manga.id, chapter.id, chapter.number);
            const proxiedPages = pages.map(p => ({
                ...p,
                url: api.imageProxyUrl(p.url, manga.id, chapter.id, chapter.number),
            }));
            this.error = null;
            this.loadedChapters = [{
                id: chapter.id,
                number: chapter.number,
                pages: proxiedPages,
                groupName: chapter.groupName,
            }];
            return true;
        } catch (e) {
            this.error = toLoadError(e);
            return false;
        }
    }

    /** Tracks the currently visible page in-memory. Called from scroll handler.
     *  Write-through: updates in-memory progress immediately, schedules debounced IDB write.
     *  This ensures pageIndex/scrollOffset survive restart even without chapter change. */
    trackVisiblePage(chapterId: string, pageIndex: number, scrollOffset: number): void {
        this.pageTracker.track(chapterId, pageIndex, scrollOffset);
        this.scheduleProgressSync(chapterId);
    }

    /** Called when the visible chapter changes. Updates currentChapterId + syncs progress. */
    syncChapterProgress(chapterId: string): void {
        this.currentChapterId = chapterId;
        this.manga.updateScrollTarget(chapterId);
        this.scheduleProgressSync(chapterId);
    }

    /** Debounced write-through: in-memory update + IDB persist. Single owner of the sync timer. */
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
            }
        });
    }

    /** Read-only access to pending page restore target. */
    get pageRestoreTarget(): { pageIndex: number; scrollOffset: number } | null {
        return this.pendingPageRestore;
    }

    /** Explicit cleanup after restore scroll is complete. */
    clearPageRestore(): void {
        this.pendingPageRestore = null;
    }

    clearHistorySync(): void {
        this.pageTracker.clearSync();
    }

    closeReader() {
        this.pageTracker.flush((chapterId, pageIndex, scrollOffset) => {
            if (!this.activeMangaId) return;
            const ch = this.manga.chapters.find(c => c.id === chapterId);
            if (ch) {
                const loaded = this.loadedChapters.find(lc => lc.id === chapterId);
                const pageCount = loaded?.pages.length;
                const progressData = { chapterId, chapterNumber: ch.number, pageIndex, pageCount, scrollOffset };
                db.setProgress(this.activeMangaId, progressData);
                this.progress.update(this.activeMangaId, progressData);
            }
        });
        this.pageTracker.destroy();
        this.loadedChapters = [];
        this.currentChapterId = null;
        this.error = null;
        this.ui.popView();
    }

    /** Find the next/prev chapter by index in the filtered list. */
    private getAdjacent(chapterId: string, direction: 'next' | 'prev'): ChapterMeta | null {
        const idx = this.chapterList.findIndex(c => c.id === chapterId);
        if (idx === -1) return null;
        const targetIdx = direction === 'next' ? idx + 1 : idx - 1;
        return this.chapterList[targetIdx] ?? null;
    }

    async appendNextChapter(): Promise<boolean> {
        if (this.isLoadingNext || !this.currentChapterId) return false;
        const manga = this.manga.activeManga;
        if (!manga) return false;

        const lastLoaded = this.loadedChapters[this.loadedChapters.length - 1];
        if (!lastLoaded) return false;

        const next = this.getAdjacent(lastLoaded.id, 'next');
        if (!next) return false;
        if (this.loadedChapters.some(c => c.id === next.id)) return false;

        this.isLoadingNext = true;
        try {
            const pages = await api.fetchChapterImages(manga.id, next.id, next.number);
            const proxiedPages = pages.map(p => ({
                ...p,
                url: api.imageProxyUrl(p.url, manga.id, next.id, next.number),
            }));
            this.loadedChapters = [...this.loadedChapters, {
                id: next.id,
                number: next.number,
                pages: proxiedPages,
                groupName: next.groupName,
            }];
            return true;
        } catch (e) {
            this.log.log('reader-append-failed', { message: String((e as Error)?.message ?? e) });
            this.toast.show(Msg.LOAD_NEXT_FAILED);
            return false;
        } finally {
            this.isLoadingNext = false;
        }
    }

    async prependPrevChapter(): Promise<LoadedChapter | null> {
        if (this.isLoadingPrev || !this.currentChapterId) return null;
        const manga = this.manga.activeManga;
        if (!manga) return null;

        const firstLoaded = this.loadedChapters[0];
        if (!firstLoaded) return null;

        const prev = this.getAdjacent(firstLoaded.id, 'prev');
        if (!prev) return null;
        if (this.loadedChapters.some(c => c.id === prev.id)) return null;

        this.isLoadingPrev = true;
        try {
            const pages = await api.fetchChapterImages(manga.id, prev.id, prev.number);
            const proxiedPages = pages.map(p => ({
                ...p,
                url: api.imageProxyUrl(p.url, manga.id, prev.id, prev.number),
            }));
            const chapter: LoadedChapter = {
                id: prev.id,
                number: prev.number,
                pages: proxiedPages,
                groupName: prev.groupName,
            };
            this.loadedChapters = [chapter, ...this.loadedChapters];
            return chapter;
        } catch (e) {
            this.log.log('reader-prepend-failed', { message: String((e as Error)?.message ?? e) });
            this.toast.show(Msg.LOAD_PREV_FAILED);
            return null;
        } finally {
            this.isLoadingPrev = false;
        }
    }
}
