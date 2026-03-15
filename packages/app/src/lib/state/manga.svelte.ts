import type { Manga, ChapterMeta } from '../types.js';
import { View } from '../logic.js';
import * as api from '../services/api.js';
import * as storage from '../services/storage.js';
import type { UIState } from './ui.svelte.js';
import type { ToastState } from './toast.svelte.js';
import type { GroupFilterState } from './groupFilter.svelte.js';
import { type LoadError, toLoadError } from './errors.js';

export class MangaState {
    activeManga = $state<Manga | null>(null);
    chapters = $state<ChapterMeta[]>([]);
    isLoading = $state(false);
    error = $state<LoadError | null>(null);
    selectedGroups = $state<Set<string>>(new Set());

    // Scroll sync: captured when entering reader, consumed by ChapterList
    private scrollAnchorRatio = 0;
    scrollTarget = $state<{ chapterId: string; ratio: number } | null>(null);

    private ui: UIState;
    private toast: ToastState;
    private gf: GroupFilterState;
    private onOpen: (() => void) | null;

    constructor(ui: UIState, toast: ToastState, gf: GroupFilterState, onOpen?: () => void) {
        this.ui = ui;
        this.toast = toast;
        this.gf = gf;
        this.onOpen = onOpen ?? null;
    }

    get filteredChapters(): ChapterMeta[] {
        let chs = this.gf.showFiltered || this.gf.count === 0
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

    private loadGroupSelection() {
        const mangaId = this.activeManga?.id;
        if (!mangaId) {
            this.selectedGroups = new Set();
            return;
        }
        this.selectedGroups = new Set(storage.getJson<string[]>(`group:${mangaId}`, []));
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
    }

    async openManga(manga: Manga) {
        this.onOpen?.();
        this.activeManga = manga;
        this.chapters = [];
        this.selectedGroups = new Set();
        this.isLoading = true;
        this.ui.pushView(View.MANGA);

        try {
            const chapters = await api.fetchChapterList(manga.id);
            this.error = null;
            this.chapters = chapters;
            this.loadGroupSelection();
        } catch (e) {
            this.error = toLoadError(e);
        } finally {
            this.isLoading = false;
        }
    }

    /** Restore manga state without pushing view (used by session restore). */
    async restoreManga(manga: Manga): Promise<boolean> {
        this.activeManga = manga;
        this.chapters = [];
        this.selectedGroups = new Set();
        this.isLoading = true;

        try {
            const chapters = await api.fetchChapterList(manga.id);
            this.error = null;
            this.chapters = chapters;
            this.loadGroupSelection();
            return true;
        } catch (e) {
            this.error = toLoadError(e);
            return false;
        } finally {
            this.isLoading = false;
        }
    }

    closeManga() {
        this.activeManga = null;
        this.chapters = [];
        this.error = null;
        this.selectedGroups = new Set();
        this.scrollTarget = null;
        this.scrollAnchorRatio = 0;
        this.ui.popView();
    }
}
