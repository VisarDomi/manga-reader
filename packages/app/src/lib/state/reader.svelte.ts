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

export interface ReaderTitleContext {
    chapterNumber: number;
    groupName: string;
}

export class ReaderState {
    loadedChapters = $state<LoadedChapter[]>([]);
    currentChapterId = $state<string | null>(null);
    error = $state<LoadError | null>(null);
    isLoadingNext = $state(false);
    isLoadingPrev = $state(false);
    pendingPageRestore = $state<{ pageIndex: number; scrollOffset: number } | null>(null);
    private activeMangaId = '';
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

            const progressData = { chapterId: chapter.id, chapterNumber: chapter.number };
            db.setProgress(manga.id, progressData);
            this.progress.update(manga.id, progressData);
            this.log.emit('progress-save', { mangaId: manga.id, ...progressData });
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

        this.log.emit('reader-open', { mangaId: manga.id, chapterId: chapter.id, chapterNumber: chapter.number, hasRestore: true });

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

    trackVisiblePage(chapterId: string, pageIndex: number, scrollOffset: number): void {
        this.pageTracker.track(chapterId, pageIndex, scrollOffset);
        this.scheduleProgressSync(chapterId);
    }

    syncChapterProgress(chapterId: string): void {
        const prevChapterId = this.currentChapterId;
        this.currentChapterId = chapterId;
        this.manga.updateScrollTarget(chapterId);
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

    closeReader() {
        const mangaId = this.activeMangaId;
        const chapterId = this.currentChapterId;

        this.pageTracker.flush((flushChapterId, pageIndex, scrollOffset) => {
            if (!mangaId) return;
            const ch = this.manga.chapters.find(c => c.id === flushChapterId);
            if (ch) {
                const loaded = this.loadedChapters.find(lc => lc.id === flushChapterId);
                const pageCount = loaded?.pages.length;
                const progressData = { chapterId: flushChapterId, chapterNumber: ch.number, pageIndex, pageCount, scrollOffset };
                db.setProgress(mangaId, progressData);
                this.progress.update(mangaId, progressData);
                this.log.emit('progress-save', { mangaId, chapterId: flushChapterId, chapterNumber: ch.number, pageIndex, pageCount });
            }
        });
        this.log.emit('reader-close', { mangaId, chapterId });
        this.pageTracker.destroy();
        this.loadedChapters = [];
        this.currentChapterId = null;
        this.error = null;
        this.ui.popView();
    }

    private getAdjacent(chapterId: string, direction: 'next' | 'prev'): ChapterMeta | null {
        const idx = this.chapterList.findIndex(c => c.id === chapterId);
        if (idx === -1) return null;
        const targetIdx = direction === 'next' ? idx + 1 : idx - 1;
        return this.chapterList[targetIdx] ?? null;
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
            this.log.emit('reader-append-ok', { mangaId: manga.id, chapterId: next.id, chapterNumber: next.number });
            return true;
        } catch (e) {
            this.log.emit('reader-append-failed', { mangaId: manga.id, chapterId: next.id, error: String((e as Error)?.message ?? e) });
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
