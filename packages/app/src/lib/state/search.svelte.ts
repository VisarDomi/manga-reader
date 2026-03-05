import { LOADING_TIMEOUT_MS } from '../constants.js';
import type { Manga } from '../types.js';
import * as api from '../services/api.js';
import * as storage from '../services/storage.js';
import type { ToastState } from './toast.svelte.js';
import { FilterState } from './filter.svelte.js';

export class SearchState {
    results = $state<Manga[]>([]);
    currentQuery = $state('');
    inputQuery = $state(''); // live value of the search input field
    currentPage = $state(1);
    isLoading = $state(false);
    hasMore = $state(false);

    readonly filters: FilterState;

    private toast: ToastState;
    private searchController: AbortController | null = null;
    private pageController: AbortController | null = null;
    private loadingWatchdog: ReturnType<typeof setTimeout> | null = null;
    private onStuck: (() => void) | null = null;
    /** Set externally by AppState before background pagination begins, to block sentinel-driven loadNextPage. */
    paginatingToTarget = false;

    constructor(toast: ToastState, onStuck?: () => void) {
        this.toast = toast;
        this.onStuck = onStuck ?? null;
        this.inputQuery = storage.getString('lastQuery', '');
        this.filters = new FilterState(() => this.search(this.inputQuery));
    }

    private startWatchdog() {
        this.clearWatchdog();
        this.loadingWatchdog = setTimeout(() => {
            if (this.isLoading) {
                this.searchController?.abort();
                this.pageController?.abort();
                this.isLoading = false;
                this.toast.show('Loading timed out — scroll to retry');
                this.onStuck?.();
            }
        }, LOADING_TIMEOUT_MS);
    }

    private clearWatchdog() {
        if (this.loadingWatchdog != null) {
            clearTimeout(this.loadingWatchdog);
            this.loadingWatchdog = null;
        }
    }

    async search(query: string) {
        this.searchController?.abort();
        this.pageController?.abort();
        const controller = new AbortController();
        this.searchController = controller;

        this.isLoading = true;
        this.startWatchdog();
        this.currentQuery = query;
        this.currentPage = 1;
        storage.setString('lastQuery', query);

        try {
            const data = await api.searchManga(query, 1, this.filters.buildFilters(), controller.signal);
            if (controller.signal.aborted) return;
            this.results = data.manga;
            this.hasMore = data.hasMore;
        } catch (e) {
            if (controller.signal.aborted) return;
            this.results = [];
            this.hasMore = false;
            this.toast.show('Search failed');
        } finally {
            this.clearWatchdog();
            if (!controller.signal.aborted) {
                this.isLoading = false;
            }
        }
    }

    /**
     * Core pagination: fetch a specific page, append deduplicated results.
     * Returns the new manga entries added (after dedup).
     */
    private async fetchAndAppendPage(page: number, signal?: AbortSignal): Promise<Manga[]> {
        const data = await api.searchManga(
            this.currentQuery, page,
            this.filters.buildFilters(), signal, true,
        );
        if (signal?.aborted) return [];
        const seen = new Set(this.results.map(m => m.id));
        const deduped = data.manga.filter(m => !seen.has(m.id));
        this.results = [...this.results, ...deduped];
        this.hasMore = data.hasMore;
        return deduped;
    }

    async loadNextPage() {
        if (this.isLoading || !this.hasMore || this.paginatingToTarget) return;

        this.isLoading = true;
        this.startWatchdog();
        this.currentPage++;

        this.pageController?.abort();
        const controller = new AbortController();
        this.pageController = controller;

        try {
            await this.fetchAndAppendPage(this.currentPage, controller.signal);
        } catch (e) {
            if (controller.signal.aborted) return;
            const isTransient = e instanceof api.ApiError &&
                (e.kind === 'timeout' || e.kind === 'network' ||
                 (e.kind === 'http' && [408, 429, 500, 502, 503, 504].includes(e.status ?? 0)));
            this.currentPage--;
            if (isTransient) {
                this.toast.show('Slow connection, scroll to retry');
            } else {
                this.hasMore = false;
                this.toast.show('Failed to load more results');
            }
        } finally {
            this.clearWatchdog();
            if (!controller.signal.aborted) {
                this.isLoading = false;
            }
        }
    }

    /**
     * Background pagination: load pages sequentially until targetId is found
     * in results, or all pages are exhausted. Returns true if target was found.
     */
    async paginateToTarget(targetId: string, signal?: AbortSignal): Promise<boolean> {
        // Check if target is already in current results
        if (this.results.some(m => m.id === targetId)) return true;

        // paginatingToTarget flag is set by the caller (AppState.bgPaginateToTarget)
        // before any async work, to block sentinel-driven loadNextPage from racing.
        while (this.hasMore) {
            if (signal?.aborted) return false;

            this.currentPage++;
            try {
                const added = await this.fetchAndAppendPage(this.currentPage, signal);
                if (signal?.aborted) return false;
                if (added.some(m => m.id === targetId)) return true;
            } catch {
                if (signal?.aborted) return false;
                this.currentPage--;
                return false;
            }
        }
        return false;
    }
}
