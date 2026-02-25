import { fetchFavorites, addFavorite, removeFavorite } from '../services/api.js';
import type { Manga } from '../types.js';
import type { ToastState } from './toast.svelte.js';

export class FavoritesState {
    items = $state<Manga[]>([]);
    isActive = $state(false);
    isLoading = $state(false);

    constructor(private toast: ToastState) {}

    async init() {
        try {
            this.items = await fetchFavorites();
        } catch {
            // silent — favorites are non-critical
        }
    }

    isFavorited(slug: string): boolean {
        return this.items.some(m => m.slug === slug);
    }

    async toggle(manga: Manga) {
        const was = this.isFavorited(manga.slug);
        // Optimistic update
        if (was) {
            this.items = this.items.filter(m => m.slug !== manga.slug);
        } else {
            this.items = [...this.items, manga];
        }
        try {
            if (was) {
                await removeFavorite(manga.slug);
                this.toast.show('Removed from favorites');
            } else {
                await addFavorite(manga);
                this.toast.show('Added to favorites');
            }
        } catch {
            // Revert optimistic update
            if (was) {
                this.items = [...this.items, manga];
            } else {
                this.items = this.items.filter(m => m.slug !== manga.slug);
            }
            this.toast.show('Failed to update favorites');
        }
    }

    async activate() {
        this.isActive = true;
        this.isLoading = true;
        try {
            this.items = await fetchFavorites();
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
