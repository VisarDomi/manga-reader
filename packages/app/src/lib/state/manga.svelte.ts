import type { Manga, ChapterMeta } from '../types.js';
import * as api from '../services/api.js';
import type { UIState } from './ui.svelte.js';
import type { ToastState } from './toast.svelte.js';

export class MangaState {
    activeManga = $state<Manga | null>(null);
    chapters = $state<ChapterMeta[]>([]);
    numericMangaId = $state<number | null>(null);
    isLoading = $state(false);

    private ui: UIState;
    private toast: ToastState;

    constructor(ui: UIState, toast: ToastState) {
        this.ui = ui;
        this.toast = toast;
    }

    async openManga(manga: Manga) {
        this.activeManga = manga;
        this.chapters = [];
        this.numericMangaId = null;
        this.isLoading = true;
        this.ui.setView('manga');

        try {
            const chapters = await api.fetchChapterList(manga.slug);
            this.chapters = chapters;
            if (chapters.length > 0 && chapters[0].mangaId) {
                this.numericMangaId = chapters[0].mangaId;
            }
        } catch (e) {
            this.toast.show('Failed to load chapters');
        } finally {
            this.isLoading = false;
        }
    }

    closeManga() {
        this.activeManga = null;
        this.chapters = [];
        this.ui.setView('list');
    }
}
