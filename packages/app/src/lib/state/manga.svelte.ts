import type { Manga, ChapterMeta, MangaComment } from '../types.js';
import { View } from '../logic.js';
import * as api from '../services/api.js';
import * as storage from '../services/storage.js';
import type { LogEmit } from '../services/LogService.js';
import type { UIState } from './ui.svelte.js';
import type { ToastState } from './toast.svelte.js';
import type { GroupFilterState } from './groupFilter.svelte.js';
import type { ChapterStatsState } from './chapterStats.svelte.js';
import type { ProgressState } from './progress.svelte.js';
import { type LoadError, toLoadError } from './errors.js';

export interface MangaEntry {
    key: string;
    manga: Manga;
    chapters: ChapterMeta[];
    comments: MangaComment[];
    commentsCount: number;
    isCommentsLoading: boolean;
    commentsError: string | null;
    isLoading: boolean;
    error: LoadError | null;
    selectedGroups: Set<string>;
    includeBlockedChapters: boolean;
    scrollAnchorRatio: number;
    scrollTarget: { chapterId: string; ratio: number } | null;
}

let entrySeq = 0;

function createEntry(manga: Manga): MangaEntry {
    return {
        key: `${manga.id}-${++entrySeq}`,
        manga,
        chapters: [],
        comments: [],
        commentsCount: 0,
        isCommentsLoading: false,
        commentsError: null,
        isLoading: true,
        error: null,
        selectedGroups: new Set(),
        includeBlockedChapters: false,
        scrollAnchorRatio: 0,
        scrollTarget: null,
    };
}

export class MangaState {
    entries = $state<MangaEntry[]>([]);
    navigationStack = $state<Manga[]>([]);

    private ui: UIState;
    private toast: ToastState;
    private gf: GroupFilterState;
    private chapterStats: ChapterStatsState;
    private progress: ProgressState;
    private emit: LogEmit;
    private onOpen: (() => void) | null;
    private detailChapterWarmKey = new Map<string, string>();

    constructor(ui: UIState, toast: ToastState, gf: GroupFilterState, chapterStats: ChapterStatsState, progress: ProgressState, emit: LogEmit, onOpen?: () => void) {
        this.ui = ui;
        this.toast = toast;
        this.gf = gf;
        this.chapterStats = chapterStats;
        this.progress = progress;
        this.emit = emit;
        this.onOpen = onOpen ?? null;
    }

    get activeEntry(): MangaEntry | null {
        return this.entries[this.entries.length - 1] ?? null;
    }

    get activeManga(): Manga | null {
        return this.activeEntry?.manga ?? null;
    }

    get activeEntryKey(): string | null {
        return this.activeEntry?.key ?? null;
    }

    get chapters(): ChapterMeta[] {
        return this.activeEntry?.chapters ?? [];
    }

    get comments(): MangaComment[] {
        return this.activeEntry?.comments ?? [];
    }

    get commentsCount(): number {
        return this.activeEntry?.commentsCount ?? 0;
    }

    get isCommentsLoading(): boolean {
        return this.activeEntry?.isCommentsLoading ?? false;
    }

    get commentsError(): string | null {
        return this.activeEntry?.commentsError ?? null;
    }

    get isLoading(): boolean {
        return this.activeEntry?.isLoading ?? false;
    }

    get error(): LoadError | null {
        return this.activeEntry?.error ?? null;
    }

    get selectedGroups(): Set<string> {
        return this.activeEntry?.selectedGroups ?? new Set();
    }

    get scrollTarget(): { chapterId: string; ratio: number } | null {
        return this.activeEntry?.scrollTarget ?? null;
    }

    private replaceEntry(entry: MangaEntry): void {
        this.entries = this.entries.map(item => item.key === entry.key ? entry : item);
    }

    private updateEntry(key: string, update: (entry: MangaEntry) => void): MangaEntry | null {
        const current = this.entryFor(key);
        if (!current) return null;
        update(current);
        this.replaceEntry(current);
        return current;
    }

    private entryFor(key?: string): MangaEntry | null {
        if (!key) return this.activeEntry;
        return this.entries.find(entry => entry.key === key) ?? null;
    }

    filteredChaptersFor(entry: MangaEntry): ChapterMeta[] {
        let chs = entry.includeBlockedChapters || this.gf.count === 0
            ? entry.chapters
            : entry.chapters.filter(ch => !this.gf.isFiltered(ch.groupId ?? ''));

        if (entry.selectedGroups.size === 0) {
            return [...chs].sort((a, b) => b.number - a.number);
        }
        const byGroup = chs.filter(ch => entry.selectedGroups.has(ch.groupId ?? ''));
        const best = new Map<number, ChapterMeta>();
        for (const ch of byGroup) {
            const existing = best.get(ch.number);
            if (!existing || (ch.uploadedAt ?? 0) > (existing.uploadedAt ?? 0))
                best.set(ch.number, ch);
        }
        return [...best.values()].sort((a, b) => b.number - a.number);
    }

    private readableChaptersFor(entry: MangaEntry): ChapterMeta[] {
        return this.filteredChaptersFor(entry).sort((a, b) => a.number - b.number);
    }

    private chooseUnreadWarmupChapter(chapters: ChapterMeta[]): ChapterMeta | null {
        const chapterOne = chapters.find(ch => ch.number === 1);
        if (chapterOne) return chapterOne;

        const firstOnePoint = chapters.find(ch => ch.number > 1 && ch.number < 2);
        if (firstOnePoint) return firstOnePoint;

        return chapters.find(ch => ch.number >= 1) ?? chapters[0] ?? null;
    }

    private chooseHistoryWarmupChapter(entry: MangaEntry, chapters: ChapterMeta[]): ChapterMeta | null {
        const saved = this.progress.get(entry.manga.id);
        if (!saved) return null;

        const savedIdx = chapters.findIndex(ch => ch.id === saved.chapterId);
        if (savedIdx !== -1) {
            return chapters[savedIdx + 1] ?? chapters[savedIdx];
        }

        return chapters.find(ch => ch.number > saved.chapterNumber) ?? null;
    }

    warmLikelyDetailChapter(entryKey?: string): void {
        const entry = this.entryFor(entryKey);
        if (!entry || entry.chapters.length === 0) return;

        const chapters = this.readableChaptersFor(entry);
        const target = this.chooseHistoryWarmupChapter(entry, chapters) ?? this.chooseUnreadWarmupChapter(chapters);
        if (!target) return;

        const progressKind = this.progress.get(entry.manga.id) ? 'history' : 'unread';
        const groupKey = entry.selectedGroups.size === 0 ? 'all' : [...entry.selectedGroups].sort().join(',');
        const warmKey = [
            entry.manga.id,
            target.id,
            progressKind,
            entry.includeBlockedChapters ? 'blocked-visible' : `blocked-hidden:${this.gf.key}`,
            groupKey,
        ].join('|');
        if (this.detailChapterWarmKey.get(entry.key) === warmKey) return;
        this.detailChapterWarmKey.set(entry.key, warmKey);

        this.emit('chapter-detail-prewarm-choice', {
            mangaId: entry.manga.id,
            chapterId: target.id,
            chapterNumber: target.number,
            reason: progressKind,
        });
        api.prewarmChapterDetails(entry.manga.id, [target]);
    }

    get filteredChapters(): ChapterMeta[] {
        const entry = this.activeEntry;
        return entry ? this.filteredChaptersFor(entry) : [];
    }

    isShowingBlockedChaptersFor(entry: MangaEntry): boolean {
        return entry.includeBlockedChapters;
    }

    get isShowingBlockedChapters(): boolean {
        return this.activeEntry?.includeBlockedChapters ?? false;
    }

    showBlockedChapters(entryKey?: string) {
        const entry = this.entryFor(entryKey);
        if (!entry) return;
        entry.includeBlockedChapters = true;
        this.replaceEntry(entry);
        this.warmLikelyDetailChapter(entry.key);
    }

    hideBlockedChapters(entryKey?: string) {
        const entry = this.entryFor(entryKey);
        if (!entry) return;
        entry.includeBlockedChapters = false;
        this.replaceEntry(entry);
        this.warmLikelyDetailChapter(entry.key);
    }

    toggleBlockedChapters(entryKey?: string) {
        const entry = this.entryFor(entryKey);
        if (!entry) return;
        entry.includeBlockedChapters = !entry.includeBlockedChapters;
        this.replaceEntry(entry);
        this.warmLikelyDetailChapter(entry.key);
    }

    private resetBlockedChapterVisibility(entry: MangaEntry) {
        entry.includeBlockedChapters = false;
    }

    private loadGroupSelection(entry: MangaEntry) {
        entry.selectedGroups = new Set(storage.getJson<string[]>(`group:${entry.manga.id}`, []));
        this.replaceEntry(entry);
    }

    refreshChapterStats(entryKey?: string): void {
        const entry = this.entryFor(entryKey);
        if (!entry || entry.chapters.length === 0) return;
        this.chapterStats.update(entry.manga.id, entry.manga.latestChapter ?? null, entry.chapters, entry.selectedGroups);
    }

    toggleGroup(id: string, entryKey?: string) {
        const entry = this.entryFor(entryKey);
        if (!entry) return;
        const next = new Set(entry.selectedGroups);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        entry.selectedGroups = next;
        if (next.size === 0) {
            storage.remove(`group:${entry.manga.id}`);
        } else {
            storage.setJson(`group:${entry.manga.id}`, [...next]);
        }
        this.replaceEntry(entry);
        this.refreshChapterStats(entry.key);
        this.warmLikelyDetailChapter(entry.key);
    }

    captureScrollAnchor(ratio: number, entryKey?: string) {
        const entry = this.entryFor(entryKey);
        if (!entry) return;
        entry.scrollAnchorRatio = ratio;
        entry.scrollTarget = null;
        this.replaceEntry(entry);
    }

    updateScrollTarget(chapterId: string, entryKey?: string) {
        const entry = this.entryFor(entryKey);
        if (!entry) return;
        entry.scrollTarget = { chapterId, ratio: entry.scrollAnchorRatio };
        this.replaceEntry(entry);
    }

    selectAllGroups(entryKey?: string) {
        const entry = this.entryFor(entryKey);
        if (!entry) return;
        entry.selectedGroups = new Set();
        storage.remove(`group:${entry.manga.id}`);
        this.replaceEntry(entry);
        this.refreshChapterStats(entry.key);
        this.warmLikelyDetailChapter(entry.key);
    }

    private async consumeChapterStream(entry: MangaEntry): Promise<void> {
        const all: ChapterMeta[] = [];
        const seen = new Set<string>();
        let pageCount = 0;
        const mangaId = entry.manga.id;

        for await (const page of api.fetchChapterList(mangaId)) {
            pageCount++;
            this.emit('chapters-page', {
                mangaId,
                page: page.pagination.currentPage,
                items: page.items.length,
                uploadedTimes: page.items.filter(ch => ch.uploadedAt != null || ch.uploadedAtLabel).length,
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
            const current = this.updateEntry(entry.key, currentEntry => {
                currentEntry.chapters = [...all];
            });
            if (current) {
                this.emit('manga-entry-state', {
                    mangaId,
                    phase: 'chapters-page',
                    recommendations: current.manga.recommendations?.length ?? 0,
                    chapters: current.chapters.length,
                    comments: current.comments.length,
                });
            }
        }
        const current = this.entryFor(entry.key);
        if (current) {
            this.emit('manga-entry-state', {
                mangaId,
                phase: 'chapters-done',
                recommendations: current.manga.recommendations?.length ?? 0,
                chapters: current.chapters.length,
                comments: current.comments.length,
            });
        }
        this.emit('chapters-done', {
            mangaId,
            pages: pageCount,
            total: all.length,
            uploadedTimes: all.filter(ch => ch.uploadedAt != null || ch.uploadedAtLabel).length,
        });
    }

    private async loadMangaDetail(entry: MangaEntry): Promise<void> {
        const manga = entry.manga;
        const start = performance.now();
        this.emit('manga-detail-start', { mangaId: manga.id });
        const detail = await api.fetchMangaDetail(manga);
        const current = this.updateEntry(entry.key, currentEntry => {
            currentEntry.manga = detail;
        });
        if (current) {
            this.emit('manga-entry-state', {
                mangaId: current.manga.id,
                phase: 'detail-applied',
                recommendations: current.manga.recommendations?.length ?? 0,
                chapters: current.chapters.length,
                comments: current.comments.length,
            });
            void this.loadMangaComments(current);
        }
        this.emit('manga-detail-done', { mangaId: manga.id, ms: Math.round(performance.now() - start) });
    }

    private async loadMangaComments(entry: MangaEntry): Promise<void> {
        const start = performance.now();
        this.updateEntry(entry.key, current => {
            current.isCommentsLoading = true;
            current.commentsError = null;
        });
        this.emit('manga-comments-start', { mangaId: entry.manga.id });

        try {
            const result = await api.fetchMangaComments(entry.manga.id);
            this.updateEntry(entry.key, current => {
                current.comments = result.comments;
                current.commentsCount = result.count;
            });
        } catch (e) {
            const current = this.updateEntry(entry.key, currentEntry => {
                currentEntry.commentsError = String((e as Error)?.message ?? e);
            });
            if (current) {
                this.emit('manga-comments-error', { mangaId: current.manga.id, error: current.commentsError });
            }
        } finally {
            const current = this.updateEntry(entry.key, currentEntry => {
                currentEntry.isCommentsLoading = false;
            });
            if (current) {
                this.emit('manga-entry-state', {
                    mangaId: current.manga.id,
                    phase: 'comments-done',
                    recommendations: current.manga.recommendations?.length ?? 0,
                    chapters: current.chapters.length,
                    comments: current.comments.length,
                });
                this.emit('manga-comments-done', { mangaId: current.manga.id, ms: Math.round(performance.now() - start) });
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

        const entry = createEntry(manga);
        this.resetBlockedChapterVisibility(entry);
        this.entries = [...this.entries, entry];
        this.ui.pushView(View.MANGA);

        try {
            void this.loadMangaDetail(entry);
            this.emit('manga-chapters-start', { mangaId: manga.id });
            await this.consumeChapterStream(entry);
            const current = this.entryFor(entry.key);
            if (current) {
                current.error = null;
                this.replaceEntry(current);
                this.loadGroupSelection(current);
                this.refreshChapterStats(current.key);
                this.warmLikelyDetailChapter(current.key);
            }
            this.emit('manga-open-done', { mangaId: manga.id, ms: Math.round(performance.now() - start) });
        } catch (e) {
            const current = this.entryFor(entry.key);
            if (current) {
                current.error = toLoadError(e);
                this.replaceEntry(current);
            }
        } finally {
            const current = this.entryFor(entry.key);
            if (current) {
                current.isLoading = false;
                this.replaceEntry(current);
            }
        }
    }

    async restoreManga(manga: Manga): Promise<boolean> {
        const stack = $state.snapshot(this.navigationStack);
        const restored = [...stack, manga].map(item => createEntry(item));
        this.entries = restored;

        const previous = restored.slice(0, -1);
        for (const entry of previous) {
            void this.restoreEntry(entry);
        }

        const active = restored[restored.length - 1];
        return active ? this.restoreEntry(active) : false;
    }

    private async restoreEntry(entry: MangaEntry): Promise<boolean> {
        const start = performance.now();
        this.emit('manga-open-start', { mangaId: entry.manga.id });
        this.resetBlockedChapterVisibility(entry);
        entry.chapters = [];
        entry.comments = [];
        entry.commentsCount = 0;
        entry.commentsError = null;
        entry.isCommentsLoading = false;
        entry.selectedGroups = new Set();
        entry.isLoading = true;
        entry.error = null;
        this.replaceEntry(entry);

        try {
            void this.loadMangaDetail(entry);
            this.emit('manga-chapters-start', { mangaId: entry.manga.id });
            await this.consumeChapterStream(entry);
            const current = this.entryFor(entry.key);
            if (!current) return false;
            current.error = null;
            this.replaceEntry(current);
            this.loadGroupSelection(current);
            this.refreshChapterStats(current.key);
            this.warmLikelyDetailChapter(current.key);
            this.emit('manga-open-done', { mangaId: current.manga.id, ms: Math.round(performance.now() - start) });
            return true;
        } catch (e) {
            const current = this.entryFor(entry.key);
            if (current) {
                current.error = toLoadError(e);
                this.replaceEntry(current);
            }
            return false;
        } finally {
            const current = this.entryFor(entry.key);
            if (current) {
                current.isLoading = false;
                this.replaceEntry(current);
            }
        }
    }

    setNavigationStack(stack: Manga[]): void {
        this.navigationStack = stack;
    }

    private clearActiveManga() {
        this.entries = [];
        this.navigationStack = [];
    }

    async closeManga() {
        const backTarget = this.ui.peekBack();
        if (backTarget === View.MANGA && this.entries.length > 1) {
            this.navigationStack = this.navigationStack.slice(0, -1);
            this.entries = this.entries.slice(0, -1);
            this.ui.popView();
            return;
        }

        this.clearActiveManga();
        this.ui.popView();
    }
}
