import type { Manga, ChapterMeta, MangaComment } from '../types.js';
import { View } from '../logic.js';
import * as api from '../services/api.js';
import * as storage from '../services/storage.js';
import { getProviderId } from '../services/provider.js';
import type { LogEmit } from '../services/LogService.js';
import type { MangaScrollSnapshot } from './session.js';
import type { UIState } from './ui.svelte.js';
import type { ToastState } from './toast.svelte.js';
import type { GroupFilterState } from './groupFilter.svelte.js';
import type { ChapterStatsState } from './chapterStats.svelte.js';
import type { ProgressState } from './progress.svelte.js';
import { type LoadError, toLoadError } from './errors.js';
import { Msg } from '../messages.js';

type MangaScrollTarget = {
    kind: 'chapter';
    chapterId: string;
    ratio: number | null;
    source: 'reader-back' | 'history';
} | {
    kind: 'section';
    section: 'recommendations';
    source: 'reader-recommendation';
};

export interface MangaEntry {
    key: string;
    manga: Manga;
    chapters: ChapterMeta[];
    comments: MangaComment[];
    commentsCount: number;
    isCommentsLoading: boolean;
    isUpdatingChapters: boolean;
    commentsError: string | null;
    isLoading: boolean;
    error: LoadError | null;
    selectedGroups: Set<string>;
    includeBlockedChapters: boolean;
    scrollAnchorRatio: number | null;
    scrollTarget: MangaScrollTarget | null;
    scrollRestore: { scrollTop: number } | null;
}

let entrySeq = 0;

function createEntry(manga: Manga): MangaEntry {
    return {
        key: `${manga.id}-${++entrySeq}`,
        manga: hideRecommendations(manga),
        chapters: [],
        comments: [],
        commentsCount: 0,
        isCommentsLoading: false,
        isUpdatingChapters: false,
        commentsError: null,
        isLoading: true,
        error: null,
        selectedGroups: new Set(),
        includeBlockedChapters: false,
        scrollAnchorRatio: null,
        scrollTarget: null,
        scrollRestore: null,
    };
}

function hideRecommendations(manga: Manga): Manga {
    return { ...manga, recommendations: [] };
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function groupSelectionKey(mangaId: string): string {
    return `group:${getProviderId()}:${mangaId}`;
}

function loadSelectedGroups(mangaId: string): Set<string> {
    const key = groupSelectionKey(mangaId);
    const scoped = storage.getJson<string[]>(key, []);
    if (scoped.length > 0 || getProviderId() !== 'comix') return new Set(scoped);

    const legacy = storage.getJson<string[]>(`group:${mangaId}`, []);
    if (legacy.length > 0) storage.setJson(key, legacy);
    return new Set(legacy);
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
    private canRunBackgroundWork: (() => boolean);
    private pendingComments = new Set<string>();
    private commentControllers = new Map<string, AbortController>();

    constructor(ui: UIState, toast: ToastState, gf: GroupFilterState, chapterStats: ChapterStatsState, progress: ProgressState, emit: LogEmit, onOpen?: () => void, canRunBackgroundWork?: () => boolean) {
        this.ui = ui;
        this.toast = toast;
        this.gf = gf;
        this.chapterStats = chapterStats;
        this.progress = progress;
        this.emit = emit;
        this.onOpen = onOpen ?? null;
        this.canRunBackgroundWork = canRunBackgroundWork ?? (() => true);
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

    get scrollTarget(): MangaScrollTarget | null {
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
    }

    hideBlockedChapters(entryKey?: string) {
        const entry = this.entryFor(entryKey);
        if (!entry) return;
        entry.includeBlockedChapters = false;
        this.replaceEntry(entry);
    }

    toggleBlockedChapters(entryKey?: string) {
        const entry = this.entryFor(entryKey);
        if (!entry) return;
        entry.includeBlockedChapters = !entry.includeBlockedChapters;
        this.replaceEntry(entry);
    }

    private resetBlockedChapterVisibility(entry: MangaEntry) {
        entry.includeBlockedChapters = false;
    }

    private loadGroupSelection(entry: MangaEntry) {
        entry.selectedGroups = loadSelectedGroups(entry.manga.id);
        this.replaceEntry(entry);
    }

    private applyGroupSelection(entry: MangaEntry) {
        entry.selectedGroups = loadSelectedGroups(entry.manga.id);
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
            storage.remove(groupSelectionKey(entry.manga.id));
        } else {
            storage.setJson(groupSelectionKey(entry.manga.id), [...next]);
        }
        this.replaceEntry(entry);
        this.refreshChapterStats(entry.key);
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
        entry.scrollTarget = { kind: 'chapter', chapterId, ratio: entry.scrollAnchorRatio, source: 'reader-back' };
        this.replaceEntry(entry);
    }

    updateRecommendationScrollTarget(entryKey?: string) {
        const entry = this.entryFor(entryKey);
        if (!entry) return;
        entry.scrollTarget = { kind: 'section', section: 'recommendations', source: 'reader-recommendation' };
        this.emit('manga-recommendation-scroll', {
            action: 'pending',
            mangaId: entry.manga.id,
        });
        this.replaceEntry(entry);
    }

    consumeScrollTarget(entryKey: string, source?: MangaScrollTarget['source']): void {
        const entry = this.entryFor(entryKey);
        if (!entry || !entry.scrollTarget) return;
        if (source && entry.scrollTarget.source !== source) return;
        entry.scrollTarget = null;
        this.replaceEntry(entry);
    }

    private applyHistoryScrollIntent(entry: MangaEntry): void {
        const saved = this.progress.get(entry.manga.id);
        if (!saved?.chapterId) return;
        entry.scrollTarget = { kind: 'chapter', chapterId: saved.chapterId, ratio: null, source: 'history' };
        this.emit('manga-history-scroll', {
            action: 'pending',
            mangaId: entry.manga.id,
            chapterId: saved.chapterId,
        });
    }

    selectAllGroups(entryKey?: string) {
        const entry = this.entryFor(entryKey);
        if (!entry) return;
        entry.selectedGroups = new Set();
        storage.remove(groupSelectionKey(entry.manga.id));
        this.replaceEntry(entry);
        this.refreshChapterStats(entry.key);
    }

    private emitEntryState(entry: MangaEntry, phase: 'detail-applied' | 'recommendations-applied' | 'chapters-page' | 'chapters-done' | 'comments-done'): void {
        this.emit('manga-entry-state', {
            mangaId: entry.manga.id,
            phase,
            recommendations: entry.manga.recommendations?.length ?? 0,
            chapters: entry.chapters.length,
            comments: entry.comments.length,
        });
    }

    private emitChapterListResult(mangaId: string, page: api.ChapterListCacheResult['page']): void {
        this.emit('chapters-page', {
            mangaId,
            page: page.pagination.currentPage,
            items: page.items.length,
            uploadedTimes: page.items.filter(ch => ch.uploadedAt != null).length,
            lastPage: page.pagination.lastPage,
            total: page.pagination.total,
        });
        this.emit('chapters-done', {
            mangaId,
            pages: Math.max(1, page.pagination.lastPage || 1),
            total: page.items.length,
            uploadedTimes: page.items.filter(ch => ch.uploadedAt != null).length,
        });
    }

    private commitMangaContent(entryKey: string, update: {
        manga?: Manga;
        chapters?: ChapterMeta[];
        isLoading?: boolean;
        isUpdatingChapters?: boolean;
        error?: LoadError | null;
    }): MangaEntry | null {
        const current = this.entryFor(entryKey);
        if (!current) return null;
        if (update.manga) current.manga = update.manga;
        if (update.chapters) {
            current.chapters = update.chapters;
            this.applyGroupSelection(current);
        }
        if (update.isLoading != null) current.isLoading = update.isLoading;
        if (update.isUpdatingChapters != null) current.isUpdatingChapters = update.isUpdatingChapters;
        if (update.error !== undefined) current.error = update.error;
        this.replaceEntry(current);
        if (update.chapters) this.refreshChapterStats(current.key);
        return current;
    }

    private async loadMangaContent(entry: MangaEntry, start: number): Promise<boolean> {
        const mangaId = entry.manga.id;
        this.emit('manga-detail-start', { mangaId });
        this.emit('manga-chapters-start', { mangaId });
        let opened = false;
        let detailDone = false;

        const emitOpenDone = (): void => {
            if (opened) return;
            opened = true;
            this.emit('manga-open-done', { mangaId, ms: Math.round(performance.now() - start) });
        };

        const emitDetailDone = (): void => {
            if (detailDone) return;
            detailDone = true;
            this.emit('manga-detail-done', { mangaId, ms: Math.round(performance.now() - start) });
        };

        const commitChapters = (chapterPeek: api.ChapterListCachePeek): boolean => {
            if (chapterPeek.status !== 'hit' || !chapterPeek.page) return false;
            const currentLatest = this.entryFor(entry.key)?.manga.latestChapter ?? entry.manga.latestChapter;
            if (chapterPeek.page.items.length === 0 && typeof currentLatest === 'number' && currentLatest > 0) {
                this.emit('chapter-list-refresh', {
                    mangaId,
                    phase: 'queued',
                    previousCount: this.entryFor(entry.key)?.chapters.length ?? 0,
                });
                return false;
            }
            const committed = this.commitMangaContent(entry.key, {
                chapters: chapterPeek.page.items,
                isLoading: false,
                isUpdatingChapters: chapterPeek.updating === true,
                error: null,
            });
            if (!committed) return false;
            this.emitChapterListResult(mangaId, chapterPeek.page);
            this.emitEntryState(committed, 'chapters-done');
            emitOpenDone();
            return true;
        };

        const commitDetail = (manga: Manga): boolean => {
            const committed = this.commitMangaContent(entry.key, {
                manga: hideRecommendations(manga),
                isLoading: false,
                error: null,
            });
            if (!committed) return false;
            this.emitEntryState(committed, 'detail-applied');
            emitOpenDone();
            return true;
        };

        const commitRecommendations = (manga: Manga): void => {
            queueMicrotask(() => {
                const committed = this.commitMangaContent(entry.key, { manga });
                if (!committed) return;
                this.emitEntryState(committed, 'recommendations-applied');
                emitDetailDone();
                this.queueMangaComments(committed);
            });
        };

        try {
            const detailPeek = await api.peekMangaDetailCache(entry.manga);
            const detailResult = detailPeek.status === 'hit' && detailPeek.manga
                ? { manga: detailPeek.manga, attempts: 0 }
                : await api.fetchMangaDetailWithCacheInfo(entry.manga);
            if (!commitDetail(detailResult.manga)) {
                return false;
            }

            const chapterPeek = await api.peekChapterListCache(mangaId);
            if (!commitChapters(chapterPeek)) {
                this.commitMangaContent(entry.key, { isUpdatingChapters: true });
            }

            commitRecommendations(detailResult.manga);
            return true;
        } catch (e) {
            const current = this.commitMangaContent(entry.key, {
                isLoading: false,
                error: toLoadError(e),
            });
            return !!current && false;
        }
    }

    private queueMangaComments(entry: MangaEntry): void {
        if (entry.comments.length > 0 || entry.isCommentsLoading) return;
        if (!this.canRunBackgroundWork()) {
            this.pendingComments.add(entry.key);
            this.emit('foreground-work', {
                owner: 'manga-comments',
                action: 'defer',
                view: this.ui.viewMode,
                mangaId: entry.manga.id,
                reason: 'foreground-reader',
            });
            return;
        }
        void this.loadMangaComments(entry);
    }

    pauseBackgroundWork(): void {
        for (const [key, controller] of this.commentControllers) {
            controller.abort();
            const entry = this.entryFor(key);
            if (entry) {
                this.pendingComments.add(key);
                this.updateEntry(key, current => {
                    current.isCommentsLoading = false;
                });
                this.emit('foreground-work', {
                    owner: 'manga-comments',
                    action: 'cancel',
                    view: this.ui.viewMode,
                    mangaId: entry.manga.id,
                    reason: 'foreground-reader',
                });
            }
        }
        this.commentControllers.clear();
    }

    resumeBackgroundWork(): void {
        if (!this.canRunBackgroundWork()) return;
        const pending = [...this.pendingComments];
        this.pendingComments.clear();
        for (const key of pending) {
            const entry = this.entryFor(key);
            if (!entry || entry.comments.length > 0 || entry.isCommentsLoading) continue;
            this.emit('foreground-work', {
                owner: 'manga-comments',
                action: 'resume',
                view: this.ui.viewMode,
                mangaId: entry.manga.id,
            });
            void this.loadMangaComments(entry);
        }
    }

    private async loadMangaComments(entry: MangaEntry): Promise<void> {
        if (!this.canRunBackgroundWork()) {
            this.pendingComments.add(entry.key);
            return;
        }
        const start = performance.now();
        const controller = new AbortController();
        this.commentControllers.set(entry.key, controller);
        this.updateEntry(entry.key, current => {
            current.isCommentsLoading = true;
            current.commentsError = null;
        });
        this.emit('manga-comments-start', { mangaId: entry.manga.id });

        try {
            const result = await api.fetchMangaComments(entry.manga.id, controller.signal);
            if (controller.signal.aborted) return;
            this.updateEntry(entry.key, current => {
                current.comments = result.comments;
                current.commentsCount = result.count;
            });
        } catch (e) {
            if (controller.signal.aborted) return;
            const current = this.updateEntry(entry.key, currentEntry => {
                currentEntry.commentsError = String((e as Error)?.message ?? e);
            });
            if (current) {
                this.emit('manga-comments-error', { mangaId: current.manga.id, error: current.commentsError });
            }
        } finally {
            this.commentControllers.delete(entry.key);
            const current = this.updateEntry(entry.key, currentEntry => {
                currentEntry.isCommentsLoading = false;
            });
            if (current && !controller.signal.aborted) {
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

    private async reconcileAfterForegroundRead(entryKey: string, manga: Manga): Promise<void> {
        const latest = manga.latestChapter;
        if (typeof latest !== 'number' || !Number.isFinite(latest) || latest <= 0) return;
        const result = await api.reconcileMangaCache(manga.id, latest, 'manga-open', 'interactive');
        if (!result || result.action === 'none') {
            const current = this.commitMangaContent(entryKey, { isUpdatingChapters: false });
            if (current) this.emit('chapter-list-refresh', { mangaId: manga.id, phase: 'fresh', previousCount: current.chapters.length });
            return;
        }
        const queued = this.commitMangaContent(entryKey, { isUpdatingChapters: true });
        if (!queued) return;
        this.toast.show(Msg.CHAPTERS_UPDATING);
        this.emit('chapter-list-refresh', { mangaId: manga.id, phase: 'queued', previousCount: queued?.chapters.length ?? 0 });
        try {
            let refreshed = await api.fetchChapterListWithCacheInfo(manga.id);
            for (let attempt = 0; refreshed.updating && attempt < 120; attempt++) {
                if (!this.entryFor(entryKey)) return;
                await delay(500);
                refreshed = await api.fetchChapterListWithCacheInfo(manga.id);
            }
            const current = this.entryFor(entryKey);
            if (!current) return;
            if (refreshed.updating) throw new Error('chapter list refresh did not finish');
            const previousCount = current.chapters.length;
            const committed = this.commitMangaContent(entryKey, {
                chapters: refreshed.page.items,
                isLoading: false,
                isUpdatingChapters: false,
                error: null,
            });
            if (committed) {
                this.emitChapterListResult(manga.id, refreshed.page);
                this.emitEntryState(committed, 'chapters-done');
                this.emit('chapter-list-refresh', {
                    mangaId: manga.id,
                    phase: 'applied',
                    previousCount,
                    nextCount: refreshed.page.items.length,
                });
            }
        } catch (e) {
            const current = this.commitMangaContent(entryKey, { isUpdatingChapters: false });
            this.emit('chapter-list-refresh', {
                mangaId: manga.id,
                phase: 'error',
                previousCount: current?.chapters.length ?? 0,
                error: String((e as Error)?.message ?? e),
            });
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
        this.applyHistoryScrollIntent(entry);
        this.entries = [...this.entries, entry];
        this.ui.pushView(View.MANGA);

        try {
            const loaded = await this.loadMangaContent(entry, start);
            const committed = this.entryFor(entry.key);
            if (loaded && committed) void this.reconcileAfterForegroundRead(entry.key, committed.manga);
        } catch (e) {
            const current = this.entryFor(entry.key);
            if (current) {
                current.error = toLoadError(e);
                this.replaceEntry(current);
            }
        }
    }

    private applyScrollRestores(entries: MangaEntry[], scrollSnapshots?: MangaScrollSnapshot[]): void {
        if (!scrollSnapshots || scrollSnapshots.length === 0) return;
        for (let index = 0; index < entries.length; index++) {
            const entry = entries[index];
            const target = scrollSnapshots.find(item => item.stackIndex === index && item.mangaId === entry.manga.id)
                ?? scrollSnapshots.find(item => item.stackIndex == null && item.mangaId === entry.manga.id);
            if (!target || target.scrollTop <= 0) continue;
            entry.scrollRestore = { scrollTop: target.scrollTop };
            this.replaceEntry(entry);
        }
    }

    async restoreManga(manga: Manga, scrollSnapshots?: MangaScrollSnapshot[]): Promise<boolean> {
        const stack = $state.snapshot(this.navigationStack);
        const restored = [...stack, manga].map(item => createEntry(item));
        this.entries = restored;

        const active = restored[restored.length - 1];
        this.applyScrollRestores(restored, scrollSnapshots);
        if (!active) return false;
        const ok = await this.restoreEntry(active, { readyAfterFirstPage: true });
        for (const entry of restored.slice(0, -1)) {
            void this.restoreEntry(entry);
        }
        return ok;
    }

    async restoreMangaShell(manga: Manga, scrollSnapshots?: MangaScrollSnapshot[]): Promise<boolean> {
        const stack = $state.snapshot(this.navigationStack);
        const restored = [...stack, manga].map(item => createEntry(item));
        this.entries = restored;

        const active = restored[restored.length - 1];
        if (!active) return false;
        this.applyScrollRestores(restored, scrollSnapshots);
        const ok = await this.restoreEntry(active, { readyAfterFirstPage: true });
        for (const entry of restored.slice(0, -1)) {
            void this.restoreEntry(entry);
        }
        return ok;
    }

    consumeScrollRestore(entryKey: string): void {
        const entry = this.entryFor(entryKey);
        if (!entry || !entry.scrollRestore) return;
        entry.scrollRestore = null;
        this.replaceEntry(entry);
    }

    async restoreMangaForReader(manga: Manga, targetChapterId: string | null, scrollSnapshots?: MangaScrollSnapshot[]): Promise<boolean> {
        const stack = $state.snapshot(this.navigationStack);
        const restored = [...stack, $state.snapshot(manga)].map(item => createEntry(item));
        this.entries = restored;
        this.applyScrollRestores(restored, scrollSnapshots);

        const active = restored[restored.length - 1];
        if (!active) return false;

        const start = performance.now();
        this.emit('manga-open-start', { mangaId: active.manga.id });
        this.resetBlockedChapterVisibility(active);
        active.chapters = [];
        active.comments = [];
        active.commentsCount = 0;
        active.commentsError = null;
        active.isCommentsLoading = false;
        active.selectedGroups = new Set();
        active.isLoading = true;
        active.error = null;
        this.replaceEntry(active);

        try {
            void targetChapterId;
            const ok = await this.loadMangaContent(active, start);
            for (const entry of restored.slice(0, -1)) {
                void this.restoreEntry(entry);
            }
            return ok;
        } catch (e) {
            const current = this.entryFor(active.key);
            if (current) {
                current.error = toLoadError(e);
                this.replaceEntry(current);
            }
            return false;
        }
    }

    private async restoreEntry(entry: MangaEntry, options?: { readyAfterFirstPage?: boolean }): Promise<boolean> {
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
            void options;
            const loaded = await this.loadMangaContent(entry, start);
            const committed = this.entryFor(entry.key);
            if (loaded && committed) void this.reconcileAfterForegroundRead(entry.key, committed.manga);
            return loaded;
        } catch (e) {
            const current = this.entryFor(entry.key);
            if (current) {
                current.error = toLoadError(e);
                this.replaceEntry(current);
            }
            return false;
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
