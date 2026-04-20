import { ConnectionMonitor } from '../services/ConnectionMonitor.svelte.js';
import { watchdog } from '../services/WatchdogService.js';
import { initProvider, getProvider } from '../services/provider.js';
import { LogService } from '../services/LogService.js';
import { setDbLogger } from '../services/db.js';
import { setCloudflareCallback, setApiLogger } from '../services/api.js';
import * as api from '../services/api.js';
import { View } from '../logic.js';
import { Msg } from '../messages.js';
import { UIState } from './ui.svelte.js';
import { SearchState } from './search.svelte.js';
import { MangaState } from './manga.svelte.js';
import { ReaderState } from './reader.svelte.js';
import { ProgressState } from './progress.svelte.js';
import { ToastState } from './toast.svelte.js';
import { FavoritesState } from './favorites.svelte.js';
import { GroupFilterState } from './groupFilter.svelte.js';
import { saveSession, loadSession, type SessionSnapshot, type SearchContext } from './session.js';
import { RESUME_RECOVERY_MS, DEEP_SLEEP_MS, VISIBLE_MANGA_DEBOUNCE_MS } from '../constants.js';

export type AppStatus = 'BOOTING' | 'READY' | 'BACKGROUND' | 'RECONNECTING' | 'OFFLINE';

const NSFW_NAMES = new Set(['Adult', 'Ecchi', 'Hentai', 'Mature', 'Smut']);
const SESSION_TOAST_DURATION = 4000;
type RestorePhase = 'replaying-search' | 'paginating-to-target' | 'scrolling';
type RestoreInner =
    | { kind: 'idle' }
    | { kind: 'active'; phase: RestorePhase; controller: AbortController; targetId: string };

class RestoreMachine {
    private inner = $state<RestoreInner>({ kind: 'idle' });

    get isActive() { return this.inner.kind === 'active'; }
    get signal() { return this.inner.kind === 'active' ? this.inner.controller.signal : undefined; }
    get targetMangaId() { return this.inner.kind === 'active' ? this.inner.targetId : null; }
    get phase() { return this.inner.kind === 'active' ? this.inner.phase : null; }

    start(targetId: string) {
        this.cancel();
        this.inner = { kind: 'active', phase: 'replaying-search', controller: new AbortController(), targetId };
    }

    transition(next: 'paginating-to-target' | 'scrolling') {
        if (this.inner.kind !== 'active') return;
        this.inner = { ...this.inner, phase: next };
    }

    cancel() {
        if (this.inner.kind !== 'active') return;
        this.inner.controller.abort();
        this.inner = { kind: 'idle' };
    }

    done() {
        this.inner = { kind: 'idle' };
    }
}
class AppState {
    readonly log = new LogService();
    ui: UIState;
    toast = new ToastState();
    searchState: SearchState;
    manga: MangaState;
    reader: ReaderState;
    progress = new ProgressState();
    favorites: FavoritesState;
    groupFilter = new GroupFilterState();

    status = $state<AppStatus>('BOOTING');
    private monitor!: ConnectionMonitor;
    private backgroundedAt = 0;
    private bgSentinelId: ReturnType<typeof setInterval> | null = null;
    private bgSentinelTick = 0;
    private restore = new RestoreMachine();
    private visibleMangaDebounce: ReturnType<typeof setTimeout> | null = null;
    private lastVisibleMangaId: string | null = null;

    constructor() {
        const emit = this.log.emit;

        this.ui = new UIState(emit);
        this.searchState = new SearchState(
            this.toast,
            () => this.recoverScrollContainers(),
            () => this.restore.phase === 'paginating-to-target',
        );
        this.searchState.onNewSearch = () => {
            if (this.restore.phase !== 'replaying-search') {
                if (this.restore.isActive) {
                    const targetId = this.restore.targetMangaId;
                    if (targetId) {
                        emit('restore-target-missed', { targetId, pagesSearched: 0, reason: 'cancelled' });
                    }
                }
                this.restore.cancel();
            }
        };
        this.manga = new MangaState(this.ui, this.toast, this.groupFilter, emit, () => this.restore.cancel());
        this.reader = new ReaderState(this.ui, this.manga, this.progress, this.toast, this.log);
        this.favorites = new FavoritesState(this.toast, this.log);
    }

    get documentTitle(): string {
        if (this.ui.viewMode !== View.READER) {
            return 'Manga Reader';
        }

        const mangaTitle = this.manga.activeManga?.title;
        const readerTitle = this.reader.titleContext;
        if (!mangaTitle || !readerTitle) {
            return 'Manga Reader';
        }

        return `Chapter ${readerTitle.chapterNumber} - ${readerTitle.groupName} - ${mangaTitle}`;
    }

    private recoverScrollContainers() {
        const ids = ['view-list', 'view-manga', 'view-reader'];
        for (const id of ids) {
            const el = document.getElementById(id);
            if (!el) continue;
            el.style.overflow = 'hidden';
        }
        requestAnimationFrame(() => {
            for (const id of ids) {
                const el = document.getElementById(id);
                if (el) el.style.overflow = '';
            }
        });
    }
    private persistSession() {
        const snapshot: SessionSnapshot = {
            viewMode: this.ui.viewMode,
            viewStack: [...this.ui.viewStack],
        };

        if (this.manga.activeManga) {
            snapshot.activeManga = $state.snapshot(this.manga.activeManga);
        }

        const target = this.manga.activeManga?.id ?? this.lastVisibleMangaId;
        if (target) {
            snapshot.targetMangaId = target;
        }

        if (this.searchState.context) {
            snapshot.searchContext = this.searchState.context;
        }

        saveSession(snapshot);
    }

    trackVisibleManga(mangaId: string) {
        this.lastVisibleMangaId = mangaId;

        if (this.visibleMangaDebounce) clearTimeout(this.visibleMangaDebounce);
        this.visibleMangaDebounce = setTimeout(() => {
            this.visibleMangaDebounce = null;
            if (this.ui.viewMode === View.LIST) {
                this.persistSession();
            }
        }, VISIBLE_MANGA_DEBOUNCE_MS);
    }
    private async restoreSession(): Promise<boolean> {
        const emit = this.log.emit;
        const snapshot = loadSession();
        if (!snapshot) {
            emit('restore-none');
            return false;
        }

        const targetId = snapshot.targetMangaId ?? null;
        emit('restore-start', {
            view: snapshot.viewMode,
            mangaId: snapshot.activeManga?.id ?? null,
            targetId,
            hasSearch: !!snapshot.searchContext,
        });

        if (snapshot.viewMode === View.LIST) {
            if (targetId) this.restore.start(targetId);
            if (snapshot.searchContext) {
                this.searchState.filters.restoreFromContext(snapshot.searchContext.filters);
                await this.searchState.replayFromContext(snapshot.searchContext);
            } else {
                await this.searchState.search(this.searchState.inputQuery);
            }
            emit('restore-search-done', { view: 'list' });
            if (targetId && this.restore.isActive) {
                this.bgPaginateToTarget();
            }
            this.persistSession();
            emit('restore-ok', { view: 'list' });
            return true;
        }

        if (snapshot.viewMode === View.FAVORITES) {
            this.ui.setViewDirect(View.FAVORITES, [View.LIST]);
            if (targetId) this.restore.start(targetId);
            this.bgReplaySearch(snapshot.searchContext);
            this.persistSession();
            emit('restore-ok', { view: 'favorites' });
            return true;
        }

        if (snapshot.viewMode === View.MANGA && snapshot.activeManga) {
            this.ui.setViewDirect(View.MANGA, [View.LIST]);
            const ok = await this.manga.restoreManga(snapshot.activeManga);
            if (!ok) {
                this.ui.setViewDirect(View.LIST, []);
                this.persistSession();
                emit('restore-fallback', { view: 'manga', reason: 'manga-load-failed' });
                return false;
            }
            if (targetId) this.restore.start(targetId);
            this.bgReplaySearch(snapshot.searchContext);
            this.persistSession();
            emit('restore-ok', { view: 'manga', mangaId: snapshot.activeManga.id });
            return true;
        }

        if (snapshot.viewMode === View.READER && snapshot.activeManga) {
            this.ui.setViewDirect(View.READER, [View.LIST, View.MANGA]);

            const ok = await this.manga.restoreManga(snapshot.activeManga);
            if (!ok) {
                this.ui.setViewDirect(View.LIST, []);
                this.persistSession();
                emit('restore-fallback', { view: 'reader', reason: 'manga-load-failed' });
                return false;
            }

            const readerOk = await this.reader.restoreReader(snapshot.activeManga);
            if (!readerOk) {
                this.ui.setViewDirect(View.MANGA, [View.LIST]);
                if (targetId) this.restore.start(targetId);
                this.bgReplaySearch(snapshot.searchContext);
                this.persistSession();
                emit('restore-fallback', { view: 'reader', reason: 'reader-load-failed', fallback: 'manga' });
                return true;
            }

            if (targetId) this.restore.start(targetId);
            this.bgReplaySearch(snapshot.searchContext);
            this.persistSession();
            emit('restore-ok', { view: 'reader', mangaId: snapshot.activeManga.id });
            return true;
        }

        this.persistSession();
        emit('restore-fallback', { view: snapshot.viewMode, reason: 'unknown-view' });
        return false;
    }

    private async bgReplaySearch(searchContext?: SearchContext) {
        if (searchContext) {
            this.searchState.filters.restoreFromContext(searchContext.filters);
            await this.searchState.replayFromContext(searchContext);
        } else {
            await this.searchState.search(this.searchState.inputQuery);
        }
        this.persistSession();
        if (!this.restore.isActive) return;
        await this.bgPaginateToTarget();
    }

    private async bgPaginateToTarget() {
        const emit = this.log.emit;
        const targetId = this.restore.targetMangaId;
        if (!targetId || !this.restore.isActive) {
            this.restore.done();
            return;
        }

        try {
            try {
                const gen = api.fetchChapterList(targetId);
                const first = await gen.next();
                if (first.done) {
                    emit('restore-target-missed', { targetId, pagesSearched: 0, reason: 'no-chapters' });
                    this.restore.done();
                    return;
                }
                await gen.return(undefined as never);
            } catch {
                emit('restore-target-missed', { targetId, pagesSearched: 0, reason: 'error' });
                this.restore.done();
                return;
            }

            if (!this.restore.isActive) return;

            if (this.searchState.results.some(m => m.id === targetId)) {
                this.restore.transition('scrolling');
                const scrolled = await this.scrollListToTarget(targetId);
                emit('restore-target-found', { targetId, page: this.searchState.currentPage, scrolled });
                if (!scrolled && this.ui.viewMode === View.LIST) {
                    this.showScrollToast(targetId);
                }
                this.restore.done();
                return;
            }

            this.restore.transition('paginating-to-target');
            const startPage = this.searchState.currentPage;
            const found = await this.searchState.paginateToTarget(targetId, this.restore.signal);

            if (!this.restore.isActive) return;

            if (found) {
                this.restore.transition('scrolling');
                const scrolled = await this.scrollListToTarget(targetId);
                emit('restore-target-found', { targetId, page: this.searchState.currentPage, scrolled });
                if (!scrolled && this.ui.viewMode === View.LIST) {
                    this.showScrollToast(targetId);
                }
                this.restore.done();
            } else {
                emit('restore-target-missed', { targetId, pagesSearched: this.searchState.currentPage - startPage, reason: 'not-found' });
                this.restore.done();
            }
        } catch {
            emit('restore-target-missed', { targetId, pagesSearched: 0, reason: 'error' });
            this.restore.done();
        }
    }

    private scrollListToTarget(targetId: string): Promise<boolean> {
        return new Promise(resolve => {
            requestAnimationFrame(() => {
                const card = document.querySelector(`[data-manga-id="${CSS.escape(targetId)}"]`);
                if (card) {
                    card.scrollIntoView({ block: 'center' });
                    resolve(true);
                } else {
                    resolve(false);
                }
            });
        });
    }

    private showScrollToast(targetId: string) {
        this.toast.show(Msg.SCROLL_TO_LAST, SESSION_TOAST_DURATION, () => {
            const card = document.querySelector(`[data-manga-id="${CSS.escape(targetId)}"]`);
            if (card) {
                card.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
        });
    }
    async init() {
        const emit = this.log.emit;
        const t0 = Date.now();

        this.log.start();
        emit('boot-start');

        setDbLogger((op, error) => emit('db-error', { op, error }));

        try {
            setApiLogger(emit);
            setCloudflareCallback(() => this.toast.show(Msg.SOLVING_CLOUDFLARE, 15000));

            await initProvider('comix', emit);

            const filters = getProvider().getFilters();
            const nsfwIds = new Set<string>();
            for (const g of filters.genres) {
                if (NSFW_NAMES.has(g.name)) nsfwIds.add(g.id);
            }
            this.searchState.filters.seedDefaults(nsfwIds);

            await Promise.all([this.progress.init(), this.favorites.init()]);

            const restored = await this.restoreSession();
            if (!restored) {
                await this.searchState.search(this.searchState.inputQuery);
            }

            this.ui.onViewChange = () => {
                this.persistSession();
                this.handleViewChanged();
            };

            this.monitor = new ConnectionMonitor(
                (online) => this.handleConnectivityChange(online),
                (visible) => this.handleVisibilityChange(visible)
            );

            watchdog.setOnFreeze((gap) => {
                emit('watchdog-freeze', { gapMs: gap });
                if (this.status === 'READY') {
                    void this.resumeFromSleep(gap);
                }
            });
            watchdog.start();

            this.status = 'READY';
            emit('boot-ready', { ms: Date.now() - t0, view: this.ui.viewMode });
        } catch (e) {
            emit('init-crash', {
                message: String((e as Error)?.message ?? e),
                stack: (e as Error)?.stack ?? '',
                ms: Date.now() - t0,
            });
        }
    }

    private handleViewChanged() {
        if (this.ui.viewMode === 'list' && this.restore.phase === 'scrolling') {
            const targetId = this.restore.targetMangaId;
            if (targetId) this.showScrollToast(targetId);
            this.restore.done();
        }
    }
    private handleConnectivityChange(online: boolean) {
        if (online) {
            this.toast.show(Msg.BACK_ONLINE);
            void this.refreshCurrentView();
            if (this.status === 'OFFLINE') this.status = 'READY';
        } else {
            this.status = 'OFFLINE';
            this.toast.show(Msg.NO_CONNECTION);
        }
    }
    private handleVisibilityChange(visible: boolean) {
        if (!visible) {
            if (this.status === 'READY') {
                this.backgroundedAt = Date.now();
                this.status = 'BACKGROUND';
                watchdog.stop();
                this.startBackgroundSentinel();
            }
        } else {
            this.stopBackgroundSentinel();
            if (this.status === 'BACKGROUND') {
                this.executeResume();
            }
        }
    }
    private executeResume() {
        if (this.status !== 'BACKGROUND') return;

        const elapsed = Date.now() - this.backgroundedAt;
        this.backgroundedAt = 0;
        this.stopBackgroundSentinel();
        watchdog.start();

        if (elapsed > RESUME_RECOVERY_MS) {
            void this.resumeFromSleep(elapsed);
        } else {
            this.status = 'READY';
        }
    }

    private resumeFromSleep(elapsed: number) {
        const emit = this.log.emit;
        const kind = elapsed > DEEP_SLEEP_MS ? 'deep-sleep' : 'recovery';
        emit('resume', { kind, elapsedMs: elapsed, view: this.ui.viewMode });

        this.recoverWarmResume();

        this.status = 'READY';

        if (elapsed > DEEP_SLEEP_MS) {
            this.toast.show(Msg.SESSION_RESTORED);
        }
    }

    private recoverWarmResume() {
        const emit = this.log.emit;
        const view = this.ui.viewMode;

        this.recoverScrollContainers();
        const searchWasStuck = this.searchState.recover();
        if (view === View.LIST) {
            this.ui.listViewGeneration++;
        }

        emit('resume-recover', {
            view,
            searchWasStuck,
            resultCount: this.searchState.results.length,
            currentPage: this.searchState.currentPage,
            query: this.searchState.currentQuery || '(browse)',
        });
    }

    private async refreshCurrentView() {
        const view = this.ui.viewMode;
        if (view === View.LIST) {
            const targetId = this.lastVisibleMangaId;
            const ctx = this.searchState.context;
            if (ctx) {
                this.searchState.filters.restoreFromContext(ctx.filters);
                await this.searchState.replayFromContext(ctx);
            } else {
                await this.searchState.search(this.searchState.currentQuery);
            }
            if (targetId) {
                this.restore.start(targetId);
                await this.bgPaginateToTarget();
            }
        } else if (view === View.MANGA && this.manga.activeManga) {
            await this.manga.restoreManga(this.manga.activeManga);
        }
    }
    private startBackgroundSentinel() {
        this.stopBackgroundSentinel();
        this.bgSentinelTick = Date.now();

        this.bgSentinelId = setInterval(() => {
            const now = Date.now();
            const delta = now - this.bgSentinelTick;
            this.bgSentinelTick = now;

            if (delta > 3000 && this.status === 'BACKGROUND' && document.visibilityState === 'visible') {
                this.log.emit('sentinel-forced-resume', { frozenSeconds: Math.round(delta / 1000) });
                this.executeResume();
            }
        }, 1000);
    }

    private stopBackgroundSentinel() {
        if (this.bgSentinelId) {
            clearInterval(this.bgSentinelId);
            this.bgSentinelId = null;
        }
    }

    destroy() {
        this.log.destroy();
        this.monitor.destroy();
        watchdog.stop();
        this.stopBackgroundSentinel();
        this.restore.cancel();
        if (this.visibleMangaDebounce) clearTimeout(this.visibleMangaDebounce);
    }
}

export const appState = new AppState();
