import * as db from '../services/db.js';
import type { Manga } from '../types.js';
import type { ToastState } from './toast.svelte.js';

export class FavoritesState {
    items = $state<Manga[]>([]);
    isActive = $state(false);
    isLoading = $state(false);

    constructor(private toast: ToastState) {}

    async init() {
        try {
            this.items = await db.getAllFavorites();
        } catch {
            this.toast.show('Storage unavailable');
        }
    }

    isFavorited(id: string): boolean {
        return this.items.some(m => m.id === id);
    }

    async toggle(manga: Manga) {
        const was = this.isFavorited(manga.id);
        // Optimistic update
        if (was) {
            this.items = this.items.filter(m => m.id !== manga.id);
        } else {
            this.items = [...this.items, manga];
        }
        try {
            if (was) {
                await db.removeFavorite(manga.id);
                this.toast.show('Removed from favorites');
            } else {
                await db.addFavorite($state.snapshot(manga));
                this.toast.show('Added to favorites');
            }
        } catch (e) {
            console.error('[favorites] toggle failed:', e);
            // Revert optimistic update
            if (was) {
                this.items = [...this.items, manga];
            } else {
                this.items = this.items.filter(m => m.id !== manga.id);
            }
            this.toast.show('Failed to update favorites');
        }
    }

    async activate() {
        this.isActive = true;
        this.isLoading = true;
        try {
            this.items = await db.getAllFavorites();
        } catch {
            this.toast.show('Failed to load favorites');
        } finally {
            this.isLoading = false;
        }
    }

    deactivate() {
        this.isActive = false;
    }
}
