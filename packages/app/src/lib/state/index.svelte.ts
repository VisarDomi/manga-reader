import { ConnectionMonitor } from '../services/ConnectionMonitor.svelte.js';
import { watchdog } from '../services/WatchdogService.js';
import { initProvider, getProvider } from '../services/provider.js';
import { setCloudflareCallback } from '../services/api.js';
import { setNsfwGenreIds } from './filter.svelte.js';
import { UIState } from './ui.svelte.js';
import { SearchState } from './search.svelte.js';
import { MangaState } from './manga.svelte.js';
import { ReaderState } from './reader.svelte.js';
import { ProgressState } from './progress.svelte.js';
import { ToastState } from './toast.svelte.js';
import { FavoritesState } from './favorites.svelte.js';
import { RESUME_RECOVERY_MS, DEEP_SLEEP_MS } from '../constants.js';

export type AppStatus = 'BOOTING' | 'READY' | 'BACKGROUND' | 'RECONNECTING' | 'OFFLINE';

const NSFW_NAMES = new Set(['Adult', 'Ecchi', 'Hentai', 'Mature', 'Smut']);

class AppState {
    ui = new UIState();
    toast = new ToastState();
    searchState: SearchState;
    manga: MangaState;
    reader: ReaderState;
    progress = new ProgressState();
    favorites: FavoritesState;

    // Lifecycle
    status = $state<AppStatus>('BOOTING');
    private monitor!: ConnectionMonitor;
    private backgroundedAt = 0;
    private bgSentinelId: ReturnType<typeof setInterval> | null = null;
    private bgSentinelTick = 0;

    constructor() {
        this.searchState = new SearchState(this.toast, () => this.recoverScrollContainers());
        this.manga = new MangaState(this.ui, this.toast);
        this.reader = new ReaderState(this.ui, this.manga, this.progress, this.toast);
        this.favorites = new FavoritesState(this.toast);
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
        await this.searchState.search(this.searchState.inputQuery);

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
            await this.manga.openManga(this.manga.activeManga);
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
    }
}

export const appState = new AppState();
