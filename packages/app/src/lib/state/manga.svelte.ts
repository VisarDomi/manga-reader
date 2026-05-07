import type { Manga, ChapterMeta, MangaComment } from '../types.js';
import { View } from '../logic.js';
import * as api from '../services/api.js';
import * as storage from '../services/storage.js';
import type { LogEmit } from '../services/LogService.js';
import type { UIState } from './ui.svelte.js';
import type { ToastState } from './toast.svelte.js';
import type { GroupFilterState } from './groupFilter.svelte.js';
import type { ChapterStatsState } from './chapterStats.svelte.js';
import { type LoadError, toLoadError } from './errors.js';

export class MangaState {
    activeManga = $state<Manga | null>(null);
    navigationStack = $state<Manga[]>([]);
    chapters = $state<ChapterMeta[]>([]);
    comments = $state<MangaComment[]>([]);
    commentsCount = $state(0);
    isCommentsLoading = $state(false);
    commentsError = $state<string | null>(null);
    isLoading = $state(false);
    error = $state<LoadError | null>(null);
    selectedGroups = $state<Set<string>>(new Set());
    private includeBlockedChapters = $state(false);

    private scrollAnchorRatio = 0;
    scrollTarget = $state<{ chapterId: string; ratio: number } | null>(null);

    private ui: UIState;
    private toast: ToastState;
    private gf: GroupFilterState;
    private chapterStats: ChapterStatsState;
    private emit: LogEmit;
    private onOpen: (() => void) | null;

    constructor(ui: UIState, toast: ToastState, gf: GroupFilterState, chapterStats: ChapterStatsState, emit: LogEmit, onOpen?: () => void) {
        this.ui = ui;
        this.toast = toast;
        this.gf = gf;
        this.chapterStats = chapterStats;
        this.emit = emit;
        this.onOpen = onOpen ?? null;
    }

    get filteredChapters(): ChapterMeta[] {
        let chs = this.includeBlockedChapters || this.gf.count === 0
            ? this.chapters
            : this.chapters.filter(ch => !this.gf.isFiltered(ch.groupId ?? ''));

        if (this.selectedGroups.size === 0) {
            return [...chs].sort((a, b) => b.number - a.number);
        }
        const byGroup = chs.filter(ch => this.selectedGroups.has(ch.groupId ?? ''));
        const best = new Map<number, ChapterMeta>();
        for (const ch of byGroup) {
            const existing = best.get(ch.number);
            if (!existing || (ch.uploadedAt ?? 0) > (existing.uploadedAt ?? 0))
                best.set(ch.number, ch);
        }
        return [...best.values()].sort((a, b) => b.number - a.number);
    }

    get isShowingBlockedChapters(): boolean {
        return this.includeBlockedChapters;
    }

    showBlockedChapters() {
        this.includeBlockedChapters = true;
    }

    hideBlockedChapters() {
        this.includeBlockedChapters = false;
    }

    toggleBlockedChapters() {
        this.includeBlockedChapters = !this.includeBlockedChapters;
    }

    private resetBlockedChapterVisibility() {
        this.includeBlockedChapters = false;
    }

    private loadGroupSelection() {
        const mangaId = this.activeManga?.id;
        if (!mangaId) {
            this.selectedGroups = new Set();
            return;
        }
        this.selectedGroups = new Set(storage.getJson<string[]>(`group:${mangaId}`, []));
    }

    refreshChapterStats(): void {
        const mangaId = this.activeManga?.id;
        if (!mangaId || this.chapters.length === 0) return;
        this.chapterStats.update(mangaId, this.activeManga?.latestChapter ?? null, this.chapters, this.selectedGroups);
    }

    toggleGroup(id: string) {
        const next = new Set(this.selectedGroups);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        this.selectedGroups = next;
        const mangaId = this.activeManga?.id;
        if (!mangaId) return;
        if (next.size === 0) {
            storage.remove(`group:${mangaId}`);
        } else {
            storage.setJson(`group:${mangaId}`, [...next]);
        }
        this.refreshChapterStats();
    }

    captureScrollAnchor(ratio: number) {
        this.scrollAnchorRatio = ratio;
        this.scrollTarget = null;
    }

    updateScrollTarget(chapterId: string) {
        this.scrollTarget = { chapterId, ratio: this.scrollAnchorRatio };
    }

    selectAllGroups() {
        this.selectedGroups = new Set();
        const mangaId = this.activeManga?.id;
        if (mangaId) storage.remove(`group:${mangaId}`);
        this.refreshChapterStats();
    }

    private async consumeChapterStream(mangaId: string): Promise<void> {
        const all: ChapterMeta[] = [];
        const seen = new Set<string>();
        let pageCount = 0;

        for await (const page of api.fetchChapterList(mangaId)) {
            pageCount++;
            this.emit('chapters-page', {
                mangaId,
                page: page.pagination.currentPage,
                items: page.items.length,
                ...(pageCount === 1 ? {
                    lastPage: page.pagination.lastPage,
                    total: page.pagination.total,
                } : {}),
            });
            for (const ch of page.items) {
                if (seen.has(ch.id)) continue;
                seen.add(ch.id);
                all.push(ch);
            }
            this.chapters = [...all];
        }
        this.emit('chapters-done', { mangaId, pages: pageCount, total: all.length });
    }

    private async loadMangaDetail(manga: Manga): Promise<void> {
        const start = performance.now();
        this.emit('manga-detail-start', { mangaId: manga.id });
        const detail = await api.fetchMangaDetail(manga);
        if (this.activeManga?.id === manga.id) {
            this.activeManga = detail;
            void this.loadMangaComments(detail);
        }
        this.emit('manga-detail-done', { mangaId: manga.id, ms: Math.round(performance.now() - start) });
    }

    private async loadMangaComments(manga: Manga): Promise<void> {
        const start = performance.now();
        this.isCommentsLoading = true;
        this.commentsError = null;
        this.emit('manga-comments-start', { mangaId: manga.id });

        try {
            const result = await api.fetchMangaComments(manga.id);
            if (this.activeManga?.id !== manga.id) return;
            this.comments = result.comments;
            this.commentsCount = result.count;
        } catch (e) {
            if (this.activeManga?.id === manga.id) {
                const message = String((e as Error)?.message ?? e);
                this.commentsError = message;
                this.emit('manga-comments-error', { mangaId: manga.id, error: message });
            }
        } finally {
            if (this.activeManga?.id === manga.id) {
                this.isCommentsLoading = false;
                this.emit('manga-comments-done', { mangaId: manga.id, ms: Math.round(performance.now() - start) });
            }
        }
    }

    async openManga(manga: Manga) {
        if (this.activeManga?.id === manga.id && this.ui.viewMode === View.MANGA) return;
        const start = performance.now();
        this.emit('manga-open-start', { mangaId: manga.id });
        this.onOpen?.();
        if (this.ui.viewMode === View.MANGA && this.activeManga) {
            this.navigationStack = [...this.navigationStack, $state.snapshot(this.activeManga)];
        }
        this.resetBlockedChapterVisibility();
        this.activeManga = manga;
        this.chapters = [];
        this.comments = [];
        this.commentsCount = 0;
        this.commentsError = null;
        this.isCommentsLoading = false;
        this.selectedGroups = new Set();
        this.isLoading = true;
        this.ui.pushView(View.MANGA);

        try {
            void this.loadMangaDetail(manga);
            this.emit('manga-chapters-start', { mangaId: manga.id });
            await this.consumeChapterStream(manga.id);
            this.error = null;
            this.loadGroupSelection();
            this.refreshChapterStats();
            this.emit('manga-open-done', { mangaId: manga.id, ms: Math.round(performance.now() - start) });
        } catch (e) {
            this.error = toLoadError(e);
        } finally {
            this.isLoading = false;
        }
    }

    async restoreManga(manga: Manga): Promise<boolean> {
        const start = performance.now();
        this.emit('manga-open-start', { mangaId: manga.id });
        this.resetBlockedChapterVisibility();
        this.activeManga = manga;
        this.chapters = [];
        this.comments = [];
        this.commentsCount = 0;
        this.commentsError = null;
        this.isCommentsLoading = false;
        this.selectedGroups = new Set();
        this.isLoading = true;

        try {
            void this.loadMangaDetail(manga);
            this.emit('manga-chapters-start', { mangaId: manga.id });
            await this.consumeChapterStream(manga.id);
            this.error = null;
            this.loadGroupSelection();
            this.refreshChapterStats();
            this.emit('manga-open-done', { mangaId: manga.id, ms: Math.round(performance.now() - start) });
            return true;
        } catch (e) {
            this.error = toLoadError(e);
            return false;
        } finally {
            this.isLoading = false;
        }
    }

    setNavigationStack(stack: Manga[]): void {
        this.navigationStack = stack;
    }

    private clearActiveManga() {
        this.resetBlockedChapterVisibility();
        this.activeManga = null;
        this.chapters = [];
        this.comments = [];
        this.commentsCount = 0;
        this.commentsError = null;
        this.isCommentsLoading = false;
        this.error = null;
        this.selectedGroups = new Set();
        this.scrollTarget = null;
        this.scrollAnchorRatio = 0;
    }

    async closeManga() {
        const backTarget = this.ui.peekBack();
        if (backTarget === View.MANGA && this.navigationStack.length > 0) {
            const previous = this.navigationStack[this.navigationStack.length - 1];
            this.navigationStack = this.navigationStack.slice(0, -1);
            this.resetBlockedChapterVisibility();
            this.activeManga = previous;
            this.chapters = [];
            this.comments = [];
            this.commentsCount = 0;
            this.commentsError = null;
            this.isCommentsLoading = false;
            this.error = null;
            this.selectedGroups = new Set();
            this.scrollTarget = null;
            this.scrollAnchorRatio = 0;
            this.ui.popView();
            const ok = await this.restoreManga(previous);
            if (!ok) {
                this.clearActiveManga();
                this.ui.resetTo(View.LIST);
            }
            return;
        }

        this.navigationStack = [];
        this.clearActiveManga();
        this.ui.popView();
    }
}
