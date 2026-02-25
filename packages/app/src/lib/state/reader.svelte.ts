import type { Manga, ChapterMeta, LoadedChapter } from '../types.js';
import * as api from '../services/api.js';
import * as db from '../services/db.js';
import { API } from '../config.js';
import { PageTracker } from '../services/PageTracker.js';
import type { UIState } from './ui.svelte.js';
import type { MangaState } from './manga.svelte.js';
import type { ProgressState } from './progress.svelte.js';
import type { ToastState } from './toast.svelte.js';

export class ReaderState {
    loadedChapters = $state<LoadedChapter[]>([]);
    currentChapterId = $state<number | null>(null);
    isLoadingNext = $state(false);
    isLoadingPrev = $state(false);
    pendingPageRestore = $state<number | null>(null);
    private activeMangaSlug = '';
    /** The filtered+deduped+sorted chapter list from manga details. Reader navigates only within this list. */
    private chapterList: ChapterMeta[] = [];
    readonly pageTracker = new PageTracker();

    private ui: UIState;
    private manga: MangaState;
    private progress: ProgressState;
    private toast: ToastState;

    constructor(ui: UIState, manga: MangaState, progress: ProgressState, toast: ToastState) {
        this.ui = ui;
        this.manga = manga;
        this.progress = progress;
        this.toast = toast;
    }

    async openReader(manga: Manga, chapter: ChapterMeta, filteredChapters: ChapterMeta[]) {
        this.activeMangaSlug = manga.slug;
        this.currentChapterId = chapter.chapterId;
        this.loadedChapters = [];
        this.isLoadingNext = false;
        this.isLoadingPrev = false;
        // Store sorted ascending (ch1, ch2, ch3, ...) for index-based navigation
        this.chapterList = [...filteredChapters].sort((a, b) => a.number - b.number);

        // Check if reopening the same chapter — restore page position
        const saved = this.progress.get(manga.slug);
        if (saved && saved.chapterId === chapter.chapterId && saved.pageIndex != null) {
            this.pendingPageRestore = saved.pageIndex;
        } else {
            this.pendingPageRestore = null;
        }

        this.ui.setView('reader');

        try {
            const pages = await api.fetchChapterImages(manga.slug, chapter.chapterId, chapter.number);
            // Proxy all image URLs through our backend to avoid CORS issues
            const proxiedPages = pages.map(p => ({
                ...p,
                url: API.IMAGE_PROXY(p.url),
            }));
            this.loadedChapters = [{
                chapterId: chapter.chapterId,
                number: chapter.number,
                pages: proxiedPages,
                groupName: chapter.scanlationGroupName,
            }];

            // Save progress (local + in-memory)
            const progressData = { chapterId: chapter.chapterId, chapterNumber: chapter.number };
            db.setProgress(manga.slug, progressData);
            this.progress.update(manga.slug, progressData);
        } catch (e) {
            console.error('Failed to open chapter:', e);
            this.toast.show('Failed to load chapter');
        }
    }

    /** Tracks the currently visible page in-memory. Called from scroll handler. */
    trackVisiblePage(chapterId: number, pageIndex: number): void {
        this.pageTracker.track(chapterId, pageIndex);
    }

    /** Called when the visible chapter changes. Updates state + debounced sync to local DB & remote API. */
    syncChapterProgress(chapterId: number): void {
        this.currentChapterId = chapterId;
        this.pageTracker.scheduleSync(chapterId, (cId, pageIndex) => {
            const manga = this.manga.activeManga;
            if (!manga) return;
            const ch = this.manga.chapters.find(c => c.chapterId === cId);
            if (ch) {
                const progressData = { chapterId: cId, chapterNumber: ch.number, pageIndex };
                db.setProgress(manga.slug, progressData);
                this.progress.update(manga.slug, progressData);
                const numId = this.manga.numericMangaId;
                if (numId) {
                    api.updateHistory(numId, cId).catch(() => {});
                }
            }
        });
    }

    /** Returns and clears the pending page restore index. */
    consumePageRestore(): number | null {
        const idx = this.pendingPageRestore;
        this.pendingPageRestore = null;
        return idx;
    }

    clearHistorySync(): void {
        this.pageTracker.clearSync();
    }

    closeReader() {
        this.pageTracker.flush((chapterId, pageIndex) => {
            if (!this.activeMangaSlug) return;
            const ch = this.manga.chapters.find(c => c.chapterId === chapterId);
            if (ch) {
                const progressData = { chapterId, chapterNumber: ch.number, pageIndex };
                db.setProgress(this.activeMangaSlug, progressData);
                this.progress.update(this.activeMangaSlug, progressData);
            }
        });
        this.pageTracker.destroy();
        this.loadedChapters = [];
        this.currentChapterId = null;
        this.ui.setView(this.ui.previousViewMode);
    }

    /** Find the next/prev chapter by index in the filtered list. */
    private getAdjacent(chapterId: number, direction: 'next' | 'prev'): ChapterMeta | null {
        const idx = this.chapterList.findIndex(c => c.chapterId === chapterId);
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

        const next = this.getAdjacent(lastLoaded.chapterId, 'next');
        if (!next) return false;
        if (this.loadedChapters.some(c => c.chapterId === next.chapterId)) return false;

        this.isLoadingNext = true;
        try {
            const pages = await api.fetchChapterImages(manga.slug, next.chapterId, next.number);
            const proxiedPages = pages.map(p => ({
                ...p,
                url: API.IMAGE_PROXY(p.url),
            }));
            this.loadedChapters = [...this.loadedChapters, {
                chapterId: next.chapterId,
                number: next.number,
                pages: proxiedPages,
                groupName: next.scanlationGroupName,
            }];
            return true;
        } catch (e) {
            console.error('Failed to append next chapter:', e);
            this.toast.show('Failed to load next chapter');
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

        const prev = this.getAdjacent(firstLoaded.chapterId, 'prev');
        if (!prev) return null;
        if (this.loadedChapters.some(c => c.chapterId === prev.chapterId)) return null;

        this.isLoadingPrev = true;
        try {
            const pages = await api.fetchChapterImages(manga.slug, prev.chapterId, prev.number);
            const proxiedPages = pages.map(p => ({
                ...p,
                url: API.IMAGE_PROXY(p.url),
            }));
            const chapter: LoadedChapter = {
                chapterId: prev.chapterId,
                number: prev.number,
                pages: proxiedPages,
                groupName: prev.scanlationGroupName,
            };
            this.loadedChapters = [chapter, ...this.loadedChapters];
            return chapter;
        } catch (e) {
            console.error('Failed to prepend prev chapter:', e);
            this.toast.show('Failed to load previous chapter');
            return null;
        } finally {
            this.isLoadingPrev = false;
        }
    }
}
