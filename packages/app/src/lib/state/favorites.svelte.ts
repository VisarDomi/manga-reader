import * as db from '../services/db.js';
import * as api from '../services/api.js';
import type { LogService } from '../services/LogService.js';
import { Msg } from '../messages.js';
import type { Manga } from '../types.js';
import type { ToastState } from './toast.svelte.js';

const HYDRATE_CONCURRENCY = 3;

export class FavoritesState {
    items = $state<Manga[]>([]);
    ids = $state<string[]>([]);
    isLoading = $state(false);
    private hydrationGeneration = 0;

    private toast: ToastState;
    private log: LogService;

    constructor(toast: ToastState, log: LogService) {
        this.toast = toast;
        this.log = log;
    }

    async init() {
        try {
            await this.loadFavoriteRows();
        } catch {
            this.toast.show(Msg.STORAGE_UNAVAILABLE);
        }
    }

    isFavorited(id: string): boolean {
        return this.ids.includes(id);
    }

    async toggle(manga: Manga) {
        const was = this.isFavorited(manga.id);
        if (was) {
            this.ids = this.ids.filter(id => id !== manga.id);
            this.items = this.items.filter(m => m.id !== manga.id);
        } else {
            this.ids = [...this.ids, manga.id];
            this.items = [...this.items, manga];
        }
        try {
            if (was) {
                await db.removeFavorite(manga.id);
                this.toast.show('Removed from favorites');
            } else {
                await db.addFavoriteId(manga.id);
                void this.hydrateOne(manga.id);
                this.toast.show('Added to favorites');
            }
        } catch (e) {
            this.log.emit('favorites-toggle-failed', { message: String((e as Error)?.message ?? e) });
            if (was) {
                this.ids = [...this.ids, manga.id];
                this.items = [...this.items, manga];
            } else {
                this.ids = this.ids.filter(id => id !== manga.id);
                this.items = this.items.filter(m => m.id !== manga.id);
            }
            this.toast.show(Msg.FAVORITE_FAILED);
        }
    }

    async activate() {
        this.isLoading = true;
        try {
            await this.loadFavoriteRows();
        } catch {
            this.toast.show('Failed to load favorites');
        } finally {
            this.isLoading = false;
        }
    }

    private placeholder(id: string, snapshot?: db.FavoriteIdRow['snapshot']): Manga {
        return {
            id,
            title: snapshot?.title ?? id,
            cover: snapshot?.cover ?? '',
            latestChapter: snapshot?.latestChapter ?? null,
        };
    }

    private async hydrateOne(id: string): Promise<void> {
        const fallback = this.items.find(item => item.id === id) ?? this.placeholder(id);
        const manga = await api.fetchMangaDetail(fallback);
        if (!this.ids.includes(id)) return;
        this.items = this.items.map(item => item.id === id ? manga : item);
    }

    private async loadFavoriteRows(): Promise<void> {
        const rows = await db.getAllFavoriteRows();
        this.hydrationGeneration++;
        const generation = this.hydrationGeneration;
        this.ids = rows.map(row => row.id);
        this.items = rows.map(row => this.items.find(item => item.id === row.id) ?? this.placeholder(row.id, row.snapshot));
        void this.hydrateRows(rows, generation);
    }

    private async hydrateRows(rows: db.FavoriteIdRow[], generation: number): Promise<void> {
        let next = 0;
        const worker = async (): Promise<void> => {
            while (generation === this.hydrationGeneration) {
                const row = rows[next++];
                if (!row) return;
                await this.hydrateOne(row.id);
            }
        };
        await Promise.all(Array.from({ length: Math.min(HYDRATE_CONCURRENCY, rows.length) }, () => worker()));
    }

}
