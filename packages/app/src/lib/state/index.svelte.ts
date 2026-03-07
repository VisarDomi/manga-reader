import { ConnectionMonitor } from '../services/ConnectionMonitor.svelte.js';
import { watchdog } from '../services/WatchdogService.js';
import { initProvider, getProvider } from '../services/provider.js';
import { setCloudflareCallback } from '../services/api.js';
import * as api from '../services/api.js';
import { setNsfwGenreIds } from './filter.svelte.js';
import { UIState } from './ui.svelte.js';
import { SearchState } from './search.svelte.js';
import { MangaState } from './manga.svelte.js';
import { ReaderState } from './reader.svelte.js';
import { ProgressState } from './progress.svelte.js';
import { ToastState } from './toast.svelte.js';
import { FavoritesState } from './favorites.svelte.js';
import { GroupFilterState } from './groupFilter.svelte.js';
import { saveSession, loadSession, clearSession, type SessionSnapshot } from './session.js';
import { RESUME_RECOVERY_MS, DEEP_SLEEP_MS } from '../constants.js';

export type AppStatus = 'BOOTING' | 'READY' | 'BACKGROUND' | 'RECONNECTING' | 'OFFLINE';

const NSFW_NAMES = new Set(['Adult', 'Ecchi', 'Hentai', 'Mature', 'Smut']);
const SESSION_TOAST_DURATION = 4000;
const VISIBLE_MANGA_DEBOUNCE_MS = 1000;

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

    // Session restore: background search pagination
    private bgSearchController: AbortController | null = null;
    // Track the target manga ID for scroll-to in list view
    private targetMangaId: string | null = null;
    private targetFound = false;
    // Pending toast for when target is found after user is already on list view
    private pendingScrollToast = false;

    // Visible manga tracking (for session snapshot "just scrolled" case)
    private visibleMangaDebounce: ReturnType<typeof setTimeout> | null = null;
    private lastVisibleMangaId: string | null = null;

    constructor() {
        this.searchState = new SearchState(this.toast, () => this.recoverScrollContainers());
        this.manga = new MangaState(this.ui, this.toast, this.groupFilter);
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
            if (this.ui.viewMode === 'list') {
                this.persistSession();
            }
        }, VISIBLE_MANGA_DEBOUNCE_MS);
    }

    // --- Session restore ---

    private async restoreSession(): Promise<boolean> {
        const snapshot = loadSession();
        if (!snapshot) return false;

        clearSession();
        this.targetMangaId = snapshot.targetMangaId ?? null;

        if (snapshot.viewMode === 'list') {
            // Run default search, then paginate to target if set
            await this.searchState.search(this.searchState.inputQuery);
            if (this.targetMangaId) {
                this.bgPaginateToTarget();
            }
            return true;
        }

        if (snapshot.viewMode === 'favorites') {
            this.ui.setViewDirect('favorites', ['list']);
            // Background: replay search for swipe-back readiness
            this.bgReplaySearch();
            return true;
        }

        if (snapshot.viewMode === 'manga' && snapshot.activeManga) {
            this.ui.setViewDirect('manga', ['list']);
            // Foreground: restore manga details
            const ok = await this.manga.restoreManga(snapshot.activeManga);
            if (!ok) {
                // Manga failed to load — fall back to list
                this.ui.setViewDirect('list', []);
                return false;
            }
            // Background: replay search for swipe-back
            this.bgReplaySearch();
            return true;
        }

        if (snapshot.viewMode === 'reader' && snapshot.activeManga) {
            this.ui.setViewDirect('reader', ['list', 'manga']);

            // First check if manga still exists by fetching chapters
            const ok = await this.manga.restoreManga(snapshot.activeManga);
            if (!ok) {
                // Manga gone — fall back to list
                this.ui.setViewDirect('list', []);
                return false;
            }

            // Now restore reader with the chapter list we just loaded
            const readerOk = await this.reader.restoreReader(snapshot.activeManga);
            if (!readerOk) {
                // Chapter failed — fall back to manga details
                this.ui.setViewDirect('manga', ['list']);
                this.bgReplaySearch();
                return true;
            }

            // Background: replay search for swipe-back
            this.bgReplaySearch();
            return true;
        }

        return false;
    }

    /**
     * Background: replay last search query and paginate to find targetMangaId.
     * Scrolls the list view to the target card when found.
     */
    private async bgReplaySearch() {
        // Run the initial search first
        await this.searchState.search(this.searchState.inputQuery);

        if (this.targetMangaId) {
            await this.bgPaginateToTarget();
        }
    }

    /**
     * Background: paginate search results until targetMangaId is found.
     * Assumes search has already been executed and results are loaded.
     */
    private async bgPaginateToTarget() {
        if (!this.targetMangaId) return;

        // Block sentinel-driven loadNextPage immediately, before any async work
        this.searchState.paginatingToTarget = true;

        try {
            // Verify the manga still exists before paginating
            try {
                await api.fetchChapterList(this.targetMangaId);
            } catch {
                // Manga no longer exists — skip pagination
                this.targetMangaId = null;
                return;
            }

            // If already found on first page
            if (this.searchState.results.some(m => m.id === this.targetMangaId)) {
                this.onTargetFound();
                return;
            }

            // Paginate in background
            this.bgSearchController?.abort();
            const controller = new AbortController();
            this.bgSearchController = controller;

            const found = await this.searchState.paginateToTarget(
                this.targetMangaId, controller.signal
            );

            if (found && !controller.signal.aborted) {
                this.onTargetFound();
            }
        } finally {
            this.searchState.paginatingToTarget = false;
        }
    }

    private async onTargetFound() {
        this.targetFound = true;

        // Scroll the list view to the target (works even when hidden via visibility:hidden)
        const scrolled = await this.scrollListToTarget();

        // Only show toast if auto-scroll failed (card not in DOM yet)
        if (!scrolled) {
            if (this.ui.viewMode === 'list') {
                this.showScrollToast();
            } else {
                this.pendingScrollToast = true;
            }
        }
    }

    /** Scrolls list view to target card. Returns true if card was found in DOM. */
    private scrollListToTarget(): Promise<boolean> {
        if (!this.targetMangaId) return Promise.resolve(false);
        return new Promise(resolve => {
            // Wait for Svelte to render the new results into the DOM
            requestAnimationFrame(() => {
                if (!this.targetMangaId) return resolve(false);
                const card = document.querySelector(`[data-manga-id="${CSS.escape(this.targetMangaId)}"]`);
                if (card) {
                    card.scrollIntoView({ block: 'center' });
                    resolve(true);
                } else {
                    resolve(false);
                }
            });
        });
    }

    private showScrollToast() {
        if (!this.targetMangaId) return;
        const targetId = this.targetMangaId;
        this.toast.show('Tap to scroll to last position', SESSION_TOAST_DURATION, () => {
            const card = document.querySelector(`[data-manga-id="${CSS.escape(targetId)}"]`);
            if (card) {
                card.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
        });
        this.pendingScrollToast = false;
    }

    // --- Init ---

    async init() {
        // Wire up Cloudflare solving toast
        setCloudflareCallback(() => this.toast.show('Solving Cloudflare...', 15000));

        // Initialize provider first — filters and API depend on it
        await initProvider();

        // Derive NSFW genre IDs from provider's filter definition
        const filters = getProvider().getFilters();
        const nsfwIds = new Set<string>();
        for (const g of filters.genres) {
            if (NSFW_NAMES.has(g.name)) nsfwIds.add(g.id);
        }
        setNsfwGenreIds(nsfwIds);

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
        if (this.ui.viewMode === 'list' && this.pendingScrollToast && this.targetFound) {
            // User navigated back to list and target was already found
            this.showScrollToast();
        } else if (this.ui.viewMode === 'list' && this.pendingScrollToast && !this.targetFound) {
            // User navigated back but target not found yet — onTargetFound will show it
        }
    }

    // --- Connectivity ---

    private handleConnectivityChange(online: boolean) {
        if (online) {
            this.toast.show('Back online');
            void this.refreshCurrentView();
            if (this.status === 'OFFLINE') this.status = 'READY';
        } else {
            this.status = 'OFFLINE';
            this.toast.show('No connection');
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
            this.toast.show('Session restored');
        }
    }

    private async refreshCurrentView() {
        const view = this.ui.viewMode;
        if (view === 'list') {
            await this.searchState.search(this.searchState.currentQuery);
        } else if (view === 'manga' && this.manga.activeManga) {
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
        this.bgSearchController?.abort();
        if (this.visibleMangaDebounce) clearTimeout(this.visibleMangaDebounce);
    }
}

export const appState = new AppState();
