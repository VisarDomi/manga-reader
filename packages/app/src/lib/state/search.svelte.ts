import { LOADING_TIMEOUT_MS } from '../constants.js';
import { Msg } from '../messages.js';
import type { Manga } from '../types.js';
import * as api from '../services/api.js';
import * as storage from '../services/storage.js';
import type { ToastState } from './toast.svelte.js';
import { FilterState } from './filter.svelte.js';
import type { SearchContext } from './session.js';
import { type LoadError, toLoadError, loadErrorMessage } from './errors.js';
import type { LogEmit } from '../services/LogService.js';
import { getProviderId } from '../services/provider.js';

export { type LoadError as SearchError, loadErrorMessage as searchErrorMessage };

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
    error = $state<LoadError | null>(null);
    currentQuery = $state('');
    inputQuery = $state('');
    currentPage = $state(1);
    hasMore = $state(false);
    resultsVersion = $state(0);

    readonly filters: FilterState;
    context: SearchContext | null = null;

    private toast: ToastState;
    private machine = new SearchMachine();
    private loadingWatchdog: ReturnType<typeof setTimeout> | null = null;
    private onStuck: (() => void) | null = null;
    private isRestoring: () => boolean;
    private emit: LogEmit;
    private reconcileReported = new Set<string>();
    onNewSearch: (() => void) | null = null;

    get isLoading() { return this.machine.isActive; }

    constructor(toast: ToastState, onStuck?: () => void, isRestoring?: () => boolean, emit?: LogEmit) {
        this.toast = toast;
        this.onStuck = onStuck ?? null;
        this.isRestoring = isRestoring ?? (() => false);
        this.emit = emit ?? (() => {}) as LogEmit;
        this.inputQuery = storage.getString('lastQuery', '');
        this.filters = new FilterState(() => this.search(this.inputQuery));
    }

    private startWatchdog() {
        this.clearWatchdog();
        this.loadingWatchdog = setTimeout(() => {
            if (this.machine.isActive) {
                this.machine.abort();
                this.toast.show(Msg.LOADING_TIMED_OUT);
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

    recover(): boolean {
        if (!this.machine.isActive) return false;
        this.machine.abort();
        this.clearWatchdog();
        return true;
    }

    resetForProvider(): void {
        this.machine.abort();
        this.clearWatchdog();
        this.results = [];
        this.error = null;
        this.currentQuery = '';
        this.currentPage = 1;
        this.hasMore = false;
        this.context = null;
        this.reconcileReported.clear();
        this.resultsVersion++;
    }

    async search(query: string) {
        this.onNewSearch?.();
        this.filters.cancelDebounce();
        this.machine.enter('searching');
        const signal = this.machine.signal!;
        this.startWatchdog();

        const ctx: SearchContext = {
            providerId: getProviderId(),
            query,
            filters: this.filters.buildFilters(),
        };
        this.context = ctx;
        this.currentQuery = query;
        this.currentPage = 1;
        storage.setString('lastQuery', query);

        try {
            const data = await api.searchManga(query, 1, ctx.filters, signal);
            if (signal.aborted) return;
            this.error = null;
            this.results = data.manga;
            this.resultsVersion++;
            this.hasMore = data.hasMore;
            this.scheduleObservedReconcile(data.manga);
        } catch (e) {
            if (signal.aborted) return;
            this.error = toLoadError(e);
            this.results = [];
            this.resultsVersion++;
            this.hasMore = false;
        } finally {
            this.clearWatchdog();
            if (!signal.aborted) {
                this.machine.done();
            }
        }
    }

    async replayFromContext(ctx: SearchContext) {
        const normalizedContext = this.contextForActiveProvider(ctx);
        this.onNewSearch?.();
        this.machine.enter('searching');
        const signal = this.machine.signal!;
        this.startWatchdog();

        this.context = normalizedContext;
        this.currentQuery = normalizedContext.query;
        this.inputQuery = normalizedContext.query;
        this.currentPage = 1;
        storage.setString('lastQuery', normalizedContext.query);

        try {
            const data = await api.searchManga(normalizedContext.query, 1, normalizedContext.filters, signal);
            if (signal.aborted) return;
            this.error = null;
            this.results = data.manga;
            this.resultsVersion++;
            this.hasMore = data.hasMore;
            this.scheduleObservedReconcile(data.manga);
        } catch (e) {
            if (signal.aborted) return;
            this.error = toLoadError(e);
            this.results = [];
            this.resultsVersion++;
            this.hasMore = false;
        } finally {
            this.clearWatchdog();
            if (!signal.aborted) {
                this.machine.done();
            }
        }
    }

    private contextForActiveProvider(ctx: SearchContext): SearchContext {
        const activeProviderId = getProviderId();
        const contextProviderId = ctx.providerId ?? 'comix';
        if (contextProviderId === activeProviderId) return ctx;
        this.emit('search-context-provider-mismatch', {
            contextProviderId,
            activeProviderId,
            includeGenres: ctx.filters?.includeGenres?.length ?? 0,
            excludeGenres: ctx.filters?.excludeGenres?.length ?? 0,
        });
        this.filters.setProvider(activeProviderId, true);
        return {
            providerId: activeProviderId,
            query: '',
            filters: this.filters.buildFilters(),
        };
    }

    private async fetchAndAppendPage(page: number, signal?: AbortSignal): Promise<Manga[]> {
        const data = await api.searchManga(
            this.currentQuery, page,
            this.context!.filters, signal, true,
        );
        if (signal?.aborted) return [];
        const seen = new Set(this.results.map(m => m.id));
        const deduped = data.manga.filter(m => !seen.has(m.id));
        this.results = [...this.results, ...deduped];
        this.resultsVersion++;
        this.hasMore = data.hasMore;
        this.scheduleObservedReconcile(deduped);
        return deduped;
    }

    private scheduleObservedReconcile(manga: Manga[]): void {
        const candidates = manga
            .filter(item => typeof item.latestChapter === 'number' && Number.isFinite(item.latestChapter) && item.latestChapter > 0)
            .slice(0, 20)
            .filter(item => {
                const key = `${item.id}:${item.latestChapter}`;
                if (this.reconcileReported.has(key)) return false;
                this.reconcileReported.add(key);
                return true;
            });
        candidates.forEach((item, index) => {
            setTimeout(() => {
                void api.reconcileMangaCache(item.id, item.latestChapter!, 'search-result', 'observed');
            }, index * 25);
        });
    }

    async loadNextPage() {
        const restoring = this.isRestoring();
        if (this.machine.isActive || !this.hasMore || restoring) {
            this.emit('search-page-flow', {
                action: 'skip',
                query: this.currentQuery || '(browse)',
                requestedPage: this.currentPage + 1,
                currentPage: this.currentPage,
                resultCount: this.results.length,
                hasMore: this.hasMore,
                machineActive: this.machine.isActive,
                isRestoring: restoring,
            });
            return;
        }

        this.machine.enter('loading-page');
        const signal = this.machine.signal!;

        this.startWatchdog();
        this.currentPage++;
        this.emit('search-page-flow', {
            action: 'start',
            query: this.currentQuery || '(browse)',
            requestedPage: this.currentPage,
            currentPage: this.currentPage,
            resultCount: this.results.length,
            hasMore: this.hasMore,
            machineActive: this.machine.isActive,
            isRestoring: false,
        });

        try {
            const added = await this.fetchAndAppendPage(this.currentPage, signal);
            this.emit('search-page-flow', {
                action: 'done',
                query: this.currentQuery || '(browse)',
                requestedPage: this.currentPage,
                currentPage: this.currentPage,
                resultCount: this.results.length,
                hasMore: this.hasMore,
                machineActive: this.machine.isActive,
                isRestoring: false,
                added: added.length,
            });
        } catch (e) {
            if (signal.aborted) return;
            const isTransient = e instanceof api.ApiError &&
                (e.kind === api.ApiErrKind.TIMEOUT || e.kind === api.ApiErrKind.NETWORK ||
                 (e.kind === api.ApiErrKind.HTTP && [408, 429, 500, 502, 503, 504].includes(e.status ?? 0)));
            this.currentPage--;
            this.emit('search-page-flow', {
                action: 'error',
                query: this.currentQuery || '(browse)',
                requestedPage: this.currentPage + 1,
                currentPage: this.currentPage,
                resultCount: this.results.length,
                hasMore: this.hasMore,
                machineActive: this.machine.isActive,
                isRestoring: false,
                error: String((e as Error)?.message ?? e),
            });
            if (isTransient) {
                this.toast.show(Msg.SLOW_CONNECTION);
            } else {
                this.hasMore = false;
                this.toast.show(Msg.LOAD_MORE_FAILED);
            }
        } finally {
            this.clearWatchdog();
            if (!signal.aborted) {
                this.machine.done();
            }
        }
    }

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
