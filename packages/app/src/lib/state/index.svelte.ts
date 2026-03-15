import { ConnectionMonitor } from '../services/ConnectionMonitor.svelte.js';
import { watchdog } from '../services/WatchdogService.js';
import { initProvider, getProvider } from '../services/provider.js';
import { setCloudflareCallback } from '../services/api.js';
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
import { saveSession, loadSession, clearSession, type SessionSnapshot, type SearchContext } from './session.js';
import { RESUME_RECOVERY_MS, DEEP_SLEEP_MS } from '../constants.js';

export type AppStatus = 'BOOTING' | 'READY' | 'BACKGROUND' | 'RECONNECTING' | 'OFFLINE';

const NSFW_NAMES = new Set(['Adult', 'Ecchi', 'Hentai', 'Mature', 'Smut']);
const SESSION_TOAST_DURATION = 4000;
const VISIBLE_MANGA_DEBOUNCE_MS = 1000;

// --- Restore State Machine ---

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

// --- App State ---

class AppState {
    ui = new UIState();
    toast = new ToastState();
    searchState: SearchState;
    manga: MangaState;
    reader: ReaderState;
    progress = new ProgressState();
    favorites: FavoritesState;
    groupFilter = new GroupFilterState();

    // Lifecycle
    status = $state<AppStatus>('BOOTING');
    private monitor!: ConnectionMonitor;
    private backgroundedAt = 0;
    private bgSentinelId: ReturnType<typeof setInterval> | null = null;
    private bgSentinelTick = 0;

    // Session restore
    private restore = new RestoreMachine();

    // Visible manga tracking (for session snapshot "just scrolled" case)
    private visibleMangaDebounce: ReturnType<typeof setTimeout> | null = null;
    private lastVisibleMangaId: string | null = null;

    constructor() {
        this.searchState = new SearchState(
            this.toast,
            () => this.recoverScrollContainers(),
            () => this.restore.phase === 'paginating-to-target',
        );
        this.searchState.onNewSearch = () => {
            // Cancel restore on user-initiated searches, but not during restore's own search replay
            if (this.restore.phase !== 'replaying-search') {
                this.restore.cancel();
            }
        };
        this.manga = new MangaState(this.ui, this.toast, this.groupFilter, () => this.restore.cancel());
        this.reader = new ReaderState(this.ui, this.manga, this.progress, this.toast);
        this.favorites = new FavoritesState(this.toast);

        // Wire up session save on every view transition
        this.ui.onViewChange = () => this.persistSession();
    }

    /**
     * Force re-layout on scroll containers to recover from iOS WebKit
     * touch handling desync. Toggling overflow forces WebKit to recreate
     * the internal scroll handler.
     */
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

    // --- Session persistence ---

    private persistSession() {
        const snapshot: SessionSnapshot = {
            viewMode: this.ui.viewMode,
            viewStack: [...this.ui.viewStack],
        };

        if (this.manga.activeManga) {
            snapshot.activeManga = $state.snapshot(this.manga.activeManga);
        }

        // targetMangaId: last clicked manga, or last visible in scroll
        const target = this.manga.activeManga?.id ?? this.lastVisibleMangaId;
        if (target) {
            snapshot.targetMangaId = target;
        }

        if (this.searchState.context) {
            snapshot.searchContext = this.searchState.context;
        }

        saveSession(snapshot);
    }

    /** Called from ListView scroll handler to track visible manga card. */
    trackVisibleManga(mangaId: string) {
        this.lastVisibleMangaId = mangaId;

        // Debounced persist so we don't write localStorage on every scroll
        if (this.visibleMangaDebounce) clearTimeout(this.visibleMangaDebounce);
        this.visibleMangaDebounce = setTimeout(() => {
            this.visibleMangaDebounce = null;
            // Only persist if we're on list view (not a stale callback)
            if (this.ui.viewMode === View.LIST) {
                this.persistSession();
            }
        }, VISIBLE_MANGA_DEBOUNCE_MS);
    }

    // --- Session restore ---

    private async restoreSession(): Promise<boolean> {
        const snapshot = loadSession();
        if (!snapshot) return false;

        clearSession();
        const targetId = snapshot.targetMangaId ?? null;

        if (snapshot.viewMode === View.LIST) {
            if (targetId) this.restore.start(targetId);
            if (snapshot.searchContext) {
                this.searchState.filters.restoreFromContext(snapshot.searchContext.filters);
                await this.searchState.replayFromContext(snapshot.searchContext);
            } else {
                await this.searchState.search(this.searchState.inputQuery);
            }
            if (targetId && this.restore.isActive) {
                this.bgPaginateToTarget();
            }
            return true;
        }

        if (snapshot.viewMode === View.FAVORITES) {
            this.ui.setViewDirect(View.FAVORITES, [View.LIST]);
            if (targetId) this.restore.start(targetId);
            this.bgReplaySearch(snapshot.searchContext);
            return true;
        }

        if (snapshot.viewMode === View.MANGA && snapshot.activeManga) {
            this.ui.setViewDirect(View.MANGA, [View.LIST]);
            const ok = await this.manga.restoreManga(snapshot.activeManga);
            if (!ok) {
                this.ui.setViewDirect(View.LIST, []);
                return false;
            }
            if (targetId) this.restore.start(targetId);
            this.bgReplaySearch(snapshot.searchContext);
            return true;
        }

        if (snapshot.viewMode === View.READER && snapshot.activeManga) {
            this.ui.setViewDirect(View.READER, [View.LIST, View.MANGA]);

            const ok = await this.manga.restoreManga(snapshot.activeManga);
            if (!ok) {
                this.ui.setViewDirect(View.LIST, []);
                return false;
            }

            const readerOk = await this.reader.restoreReader(snapshot.activeManga);
            if (!readerOk) {
                this.ui.setViewDirect(View.MANGA, [View.LIST]);
                if (targetId) this.restore.start(targetId);
                this.bgReplaySearch(snapshot.searchContext);
                return true;
            }

            if (targetId) this.restore.start(targetId);
            this.bgReplaySearch(snapshot.searchContext);
            return true;
        }

        return false;
    }

    /**
     * Background: replay last search query and paginate to find target.
     * Scrolls the list view to the target card when found.
     */
    private async bgReplaySearch(searchContext?: SearchContext) {
        if (searchContext) {
            this.searchState.filters.restoreFromContext(searchContext.filters);
            await this.searchState.replayFromContext(searchContext);
        } else {
            await this.searchState.search(this.searchState.inputQuery);
        }
        if (!this.restore.isActive) return; // cancelled during search
        await this.bgPaginateToTarget();
    }

    /**
     * Background: paginate search results until target is found.
     * Assumes search has already been executed and results are loaded.
     */
    private async bgPaginateToTarget() {
        const targetId = this.restore.targetMangaId;
        if (!targetId || !this.restore.isActive) {
            this.restore.done();
            return;
        }

        try {
            // Verify the manga still exists before paginating
            try {
                await api.fetchChapterList(targetId);
            } catch {
                this.restore.done();
                return;
            }

            if (!this.restore.isActive) return; // cancelled during verify

            // If already found on first page
            if (this.searchState.results.some(m => m.id === targetId)) {
                this.restore.transition('scrolling');
                await this.onTargetFound(targetId);
                return;
            }

            // Paginate in background
            this.restore.transition('paginating-to-target');
            const found = await this.searchState.paginateToTarget(targetId, this.restore.signal);

            if (!this.restore.isActive) return; // cancelled during pagination

            if (found) {
                this.restore.transition('scrolling');
                await this.onTargetFound(targetId);
            } else {
                this.restore.done();
            }
        } catch {
            this.restore.done();
        }
    }

    private async onTargetFound(targetId: string) {
        const scrolled = await this.scrollListToTarget(targetId);

        if (!scrolled) {
            if (this.ui.viewMode === View.LIST) {
                this.showScrollToast(targetId);
                this.restore.done();
            }
            // else: machine stays in 'scrolling' — handleViewChanged will show toast
        } else {
            this.restore.done();
        }
    }

    /** Scrolls list view to target card. Returns true if card was found in DOM. */
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

    // --- Init ---

    async init() {
        // Wire up Cloudflare solving toast
        setCloudflareCallback(() => this.toast.show(Msg.SOLVING_CLOUDFLARE, 15000));

        // Initialize provider first — filters and API depend on it
        await initProvider();

        // Derive NSFW genre IDs from provider's filter definition
        const filters = getProvider().getFilters();
        const nsfwIds = new Set<string>();
        for (const g of filters.genres) {
            if (NSFW_NAMES.has(g.name)) nsfwIds.add(g.id);
        }
        this.searchState.filters.seedDefaults(nsfwIds);

        await Promise.all([this.progress.init(), this.favorites.init()]);

        // Attempt session restore; if no deep restore, run default search
        const restored = await this.restoreSession();
        if (!restored) {
            await this.searchState.search(this.searchState.inputQuery);
        }

        // Hook into view changes to detect when user navigates back to list
        const origOnViewChange = this.ui.onViewChange;
        this.ui.onViewChange = () => {
            origOnViewChange?.();
            this.handleViewChanged();
        };

        // Start lifecycle monitoring
        this.monitor = new ConnectionMonitor(
            (online) => this.handleConnectivityChange(online),
            (visible) => this.handleVisibilityChange(visible)
        );

        watchdog.setOnFreeze((gap) => {
            if (this.status === 'READY') {
                void this.resumeFromSleep(gap);
            }
        });
        watchdog.start();

        this.status = 'READY';
    }

    /** Called on every view transition to handle pending scroll-to notifications. */
    private handleViewChanged() {
        if (this.ui.viewMode === 'list' && this.restore.phase === 'scrolling') {
            const targetId = this.restore.targetMangaId;
            if (targetId) this.showScrollToast(targetId);
            this.restore.done();
        }
    }

    // --- Connectivity ---

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

    // --- Visibility (primary resume signal) ---

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

    // --- Resume logic ---

    private executeResume() {
        if (this.status !== 'BACKGROUND') return;

        const elapsed = Date.now() - this.backgroundedAt;
        this.backgroundedAt = 0;
        this.stopBackgroundSentinel();
        watchdog.start();

        if (elapsed > RESUME_RECOVERY_MS) {
            void this.resumeFromSleep(elapsed);
        } else {
            // Quick switch — just go back to READY, no refresh needed
            this.status = 'READY';
        }
    }

    private async resumeFromSleep(elapsed: number) {
        this.status = 'RECONNECTING';

        await this.refreshCurrentView();

        this.status = 'READY';

        if (elapsed > DEEP_SLEEP_MS) {
            this.toast.show(Msg.SESSION_RESTORED);
        }
    }

    private async refreshCurrentView() {
        const view = this.ui.viewMode;
        if (view === View.LIST) {
            await this.searchState.search(this.searchState.currentQuery);
        } else if (view === View.MANGA && this.manga.activeManga) {
            // Use restoreManga to refresh chapters without pushing view again
            await this.manga.restoreManga(this.manga.activeManga);
        }
        // reader: no refresh needed — images are already loaded/blobbed
    }

    // --- iOS background sentinel ---
    // iOS PWA freezes JS when backgrounded. When it resumes, visibilitychange
    // often doesn't fire. This sentinel interval detects the freeze via time drift.

    private startBackgroundSentinel() {
        this.stopBackgroundSentinel();
        this.bgSentinelTick = Date.now();

        this.bgSentinelId = setInterval(() => {
            const now = Date.now();
            const delta = now - this.bgSentinelTick;
            this.bgSentinelTick = now;

            if (delta > 3000 && this.status === 'BACKGROUND' && document.visibilityState === 'visible') {
                console.warn(`[AppState] Sentinel: visibilitychange missed, forcing resume (frozen ${Math.round(delta / 1000)}s)`);
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
        this.monitor.destroy();
        watchdog.stop();
        this.stopBackgroundSentinel();
        this.restore.cancel();
        if (this.visibleMangaDebounce) clearTimeout(this.visibleMangaDebounce);
    }
}

export const appState = new AppState();
