import { LOADING_TIMEOUT_MS } from '../constants.js';
import type { Manga } from '../types.js';
import * as api from '../services/api.js';
import * as storage from '../services/storage.js';
import type { ToastState } from './toast.svelte.js';
import { FilterState } from './filter.svelte.js';

type SearchMachineState = 'idle' | 'searching' | 'loading-page';

class SearchMachine {
    state = $state<SearchMachineState>('idle');
    private controller: AbortController | null = null;

    get isActive() { return this.state !== 'idle'; }
    get signal() { return this.controller?.signal; }

    enter(next: 'searching' | 'loading-page') {
        this.controller?.abort();
        this.controller = new AbortController();
        this.state = next;
    }

    done() {
        this.controller = null;
        this.state = 'idle';
    }

    abort() {
        this.controller?.abort();
        this.controller = null;
        this.state = 'idle';
    }
}

export class SearchState {
    results = $state<Manga[]>([]);
    currentQuery = $state('');
    inputQuery = $state(''); // live value of the search input field
    currentPage = $state(1);
    hasMore = $state(false);

    readonly filters: FilterState;

    private toast: ToastState;
    private machine = new SearchMachine();
    private loadingWatchdog: ReturnType<typeof setTimeout> | null = null;
    private onStuck: (() => void) | null = null;
    private isRestoring: () => boolean;
    /** Fired at the start of every search(). AppState uses this to cancel restore on user-initiated searches. */
    onNewSearch: (() => void) | null = null;

    get isLoading() { return this.machine.isActive; }

    constructor(toast: ToastState, onStuck?: () => void, isRestoring?: () => boolean) {
        this.toast = toast;
        this.onStuck = onStuck ?? null;
        this.isRestoring = isRestoring ?? (() => false);
        this.inputQuery = storage.getString('lastQuery', '');
        this.filters = new FilterState(() => this.search(this.inputQuery));
    }

    private startWatchdog() {
        this.clearWatchdog();
        this.loadingWatchdog = setTimeout(() => {
            if (this.machine.isActive) {
                this.machine.abort();
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
        this.onNewSearch?.();
        this.machine.enter('searching');
        const signal = this.machine.signal!;

        this.startWatchdog();
        this.currentQuery = query;
        this.currentPage = 1;
        storage.setString('lastQuery', query);

        try {
            const data = await api.searchManga(query, 1, this.filters.buildFilters(), signal);
            if (signal.aborted) return;
            this.results = data.manga;
            this.hasMore = data.hasMore;
        } catch (e) {
            if (signal.aborted) return;
            this.results = [];
            this.hasMore = false;
            this.toast.show('Search failed');
        } finally {
            this.clearWatchdog();
            if (!signal.aborted) {
                this.machine.done();
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
        if (this.machine.isActive || !this.hasMore || this.isRestoring()) return;

        this.machine.enter('loading-page');
        const signal = this.machine.signal!;

        this.startWatchdog();
        this.currentPage++;

        try {
            await this.fetchAndAppendPage(this.currentPage, signal);
        } catch (e) {
            if (signal.aborted) return;
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
            if (!signal.aborted) {
                this.machine.done();
            }
        }
    }

    /**
     * Background pagination: load pages sequentially until targetId is found
     * in results, or all pages are exhausted. Returns true if target was found.
     */
    async paginateToTarget(targetId: string, signal?: AbortSignal): Promise<boolean> {
        if (this.results.some(m => m.id === targetId)) return true;

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
