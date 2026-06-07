import * as db from '../services/db.js';
import * as api from '../services/api.js';
import type { LogService } from '../services/LogService.js';
import { Msg } from '../messages.js';
import type { Manga } from '../types.js';
import type { ChapterStatsState } from './chapterStats.svelte.js';
import type { ToastState } from './toast.svelte.js';
import { getProviderId } from '../services/provider.js';

export class FavoritesState {
    items = $state<Manga[]>([]);
    ids = $state<string[]>([]);
    isLoading = $state(false);
    private hydrationGeneration = 0;
    private loaded = false;
    private loadedProviderId: string | null = null;
    private static readonly FIRST_VISIBLE_COVER_COUNT = 12;
    private static readonly REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
    private static readonly REFRESH_POLL_MS = 5000;
    private static readonly REFRESH_POLL_ATTEMPTS = 24;

    private toast: ToastState;
    private log: LogService;
    private chapterStats: ChapterStatsState;

    constructor(toast: ToastState, log: LogService, chapterStats: ChapterStatsState) {
        this.toast = toast;
        this.log = log;
        this.chapterStats = chapterStats;
    }

    async init() {
        try {
            this.loaded = await this.loadFavoriteRows();
        } catch (e) {
            this.log.emit('favorites-activation', {
                phase: 'failed',
                loaded: this.loaded,
                items: this.items.length,
                dtMs: 0,
                error: String((e as Error)?.message ?? e),
            });
            this.toast.show(Msg.STORAGE_UNAVAILABLE);
        }
    }

    isFavorited(id: string): boolean {
        return this.ids.includes(id);
    }

    resetForProvider(): void {
        this.hydrationGeneration++;
        this.loaded = false;
        this.loadedProviderId = null;
        this.ids = [];
        this.items = [];
        this.isLoading = false;
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
                await db.removeFavorite(manga.id, getProviderId());
                this.toast.show('Removed from favorites');
            } else {
                await db.addFavorite(manga, getProviderId());
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
        await this.prepareRoot();
    }

    async prepareRoot() {
        const providerId = getProviderId();
        if (this.loaded && this.loadedProviderId === providerId) {
            this.queueRefreshFromVisibleFavorites('activate');
            return;
        }
        const startedAt = performance.now();
        this.log.emit('favorites-activation', { phase: 'start', loaded: this.loaded, items: this.items.length, dtMs: 0 });
        this.isLoading = true;
        try {
            const loaded = await this.loadFavoriteRows(providerId);
            if (!loaded || providerId !== getProviderId()) return;
            const generation = this.hydrationGeneration;
            const coverPrep = this.prepareCoverImages(this.items, providerId, FavoritesState.FIRST_VISIBLE_COVER_COUNT);
            await coverPrep.visibleReady;
            if (providerId !== getProviderId()) return;
            this.loaded = true;
            this.log.emit('favorites-activation', { phase: 'done', loaded: this.loaded, items: this.items.length, dtMs: Math.round(performance.now() - startedAt) });
            void coverPrep.allReady;
            void this.refreshFavoriteSnapshots(this.items, generation, providerId);
            this.queueRefreshFromVisibleFavorites('activate');
        } catch (e) {
            this.log.emit('favorites-activation', {
                phase: 'failed',
                loaded: this.loaded,
                items: this.items.length,
                dtMs: Math.round(performance.now() - startedAt),
                error: String((e as Error)?.message ?? e),
            });
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

    private async loadFavoriteRows(providerId = getProviderId()): Promise<boolean> {
        const startedAt = performance.now();
        const rows = await db.getAllFavoriteRows(providerId);
        if (providerId !== getProviderId()) return false;
        this.hydrationGeneration++;
        const generation = this.hydrationGeneration;
        this.loadedProviderId = providerId;
        this.ids = rows.map(row => row.id);
        this.items = rows.map(row => this.items.find(item => item.id === row.id) ?? this.placeholder(row.id, row.snapshot));
        this.log.emit('favorites-rows-loaded', {
            rows: rows.length,
            snapshots: rows.filter(row => row.snapshot != null).length,
            items: this.items.length,
            dtMs: Math.round(performance.now() - startedAt),
        });
        return true;
    }

    private async refreshFavoriteSnapshots(items: Manga[], generation: number, providerId: string): Promise<void> {
        if (items.length === 0) return;
        const startedAt = performance.now();
        const fallbacks = [...items];
        this.log.emit('favorites-hydration', {
            phase: 'start',
            total: items.length,
            batchSize: items.length,
            dtMs: 0,
        });

        const batchStartedAt = performance.now();
        const count = await this.repairCardSnapshots(fallbacks, generation, providerId);
        if (count == null) {
            this.log.emit('favorites-hydration', {
                phase: 'cancelled',
                total: items.length,
                batchSize: items.length,
                batchIndex: 0,
                count: 0,
                dtMs: Math.round(performance.now() - startedAt),
            });
            return;
        }
        this.log.emit('favorites-hydration', {
            phase: 'batch',
            total: items.length,
            batchSize: items.length,
            batchIndex: 0,
            count,
            dtMs: Math.round(performance.now() - batchStartedAt),
        });

        this.log.emit('favorites-hydration', {
            phase: 'done',
            total: items.length,
            batchSize: items.length,
            dtMs: Math.round(performance.now() - startedAt),
        });
    }

    private async repairCardSnapshots(fallbacks: Manga[], generation: number, providerId: string): Promise<number | null> {
        if (generation !== this.hydrationGeneration || providerId !== this.loadedProviderId || providerId !== getProviderId()) return null;
        const startedAt = performance.now();
        let snapshots: api.MangaCardSnapshot[] = [];
        try {
            snapshots = await api.fetchMangaCardSnapshots(fallbacks, undefined, true, providerId);
        } catch (e) {
            this.log.emit('favorites-hydration-failed', {
                total: fallbacks.length,
                dtMs: Math.round(performance.now() - startedAt),
                error: String((e as Error)?.message ?? e),
            });
            return 0;
        }
        if (generation !== this.hydrationGeneration || providerId !== this.loadedProviderId || providerId !== getProviderId()) return null;

        const activeIds = new Set(this.ids);
        const hydrated = snapshots.filter(snapshot => activeIds.has(snapshot.manga.id));
        if (hydrated.length === 0) return 0;

        for (const result of hydrated) {
            void db.updateFavoriteSnapshot(result.manga, providerId);
            if (!result.chapters) continue;
            this.chapterStats.update(result.manga.id, result.manga.latestChapter ?? null, result.chapters);
        }
        return hydrated.length;
    }

    refreshChapterStats(): void {
        const generation = this.hydrationGeneration;
        const providerId = this.loadedProviderId ?? getProviderId();
        const startedAt = performance.now();
        void api.fetchMangaCardSnapshots(this.items, undefined, true, providerId)
            .then(snapshots => {
                if (generation !== this.hydrationGeneration || providerId !== this.loadedProviderId || providerId !== getProviderId()) return;
                for (const result of snapshots) {
                    if (!result.chapters) continue;
                    this.chapterStats.update(result.manga.id, result.manga.latestChapter ?? null, result.chapters);
                }
            })
            .catch(e => {
                this.log.emit('favorites-hydration-failed', {
                    total: this.items.length,
                    dtMs: Math.round(performance.now() - startedAt),
                    error: String((e as Error)?.message ?? e),
                });
            });
    }

    queueStartupRefresh(): void {
        const providerId = getProviderId();
        void (async () => {
            const rows = await db.getAllFavoriteRows(providerId);
            const items = rows.map(row => this.placeholder(row.id, row.snapshot));
            this.queueFavoriteRefresh(items, providerId, 'app-start', true);
        })().catch(e => {
            this.log.emit('favorites-hydration-failed', {
                total: 0,
                dtMs: 0,
                error: String((e as Error)?.message ?? e),
            });
        });
    }

    private queueRefreshFromVisibleFavorites(reason: 'activate'): void {
        this.queueFavoriteRefresh([...this.items], this.loadedProviderId ?? getProviderId(), reason, false);
    }

    private queueFavoriteRefresh(items: Manga[], providerId: string, reason: 'app-start' | 'activate', force: boolean): void {
        if (items.length === 0) return;
        const key = `manga:favorites:lastRefresh:${providerId}`;
        const now = Date.now();
        const last = Number(localStorage.getItem(key) ?? 0);
        const due = force || !Number.isFinite(last) || now - last >= FavoritesState.REFRESH_INTERVAL_MS;
        if (!due) return;
        localStorage.setItem(key, String(now));
        void this.refreshFavoriteSnapshotsUntilSettled(items, providerId, `favorites-${reason}`);
    }

    private async refreshFavoriteSnapshotsUntilSettled(items: Manga[], providerId: string, reason: string): Promise<void> {
        const startedAt = performance.now();
        try {
            let previousSignature = this.favoriteSnapshotSignature(this.items);
            for (let attempt = 0; attempt < FavoritesState.REFRESH_POLL_ATTEMPTS; attempt++) {
                const snapshots = await api.fetchMangaCardSnapshots(items, undefined, true, providerId, {
                    enabled: attempt === 0,
                    reason,
                });
                if (providerId !== getProviderId()) return;
                const activeIds = new Set(this.ids);
                const hydrated = snapshots.filter(snapshot => activeIds.has(snapshot.manga.id));
                if (hydrated.length > 0) {
                    for (const result of hydrated) {
                        void db.updateFavoriteSnapshot(result.manga, providerId);
                        if (result.chapters) this.chapterStats.update(result.manga.id, result.manga.latestChapter ?? null, result.chapters);
                    }
                    const byId = new Map(hydrated.map(item => [item.manga.id, item.manga]));
                    this.items = this.items.map(item => byId.get(item.id) ?? item);
                    const nextSignature = this.favoriteSnapshotSignature(this.items);
                    if (attempt > 0 && nextSignature !== previousSignature) {
                        this.log.emit('favorites-hydration', {
                            phase: 'done',
                            total: items.length,
                            batchSize: items.length,
                            dtMs: Math.round(performance.now() - startedAt),
                        });
                        return;
                    }
                    previousSignature = nextSignature;
                }
                await this.delay(FavoritesState.REFRESH_POLL_MS);
            }
        } catch (e) {
            this.log.emit('favorites-hydration-failed', {
                total: items.length,
                dtMs: Math.round(performance.now() - startedAt),
                error: String((e as Error)?.message ?? e),
            });
        }
    }

    private favoriteSnapshotSignature(items: Manga[]): string {
        return items.map(item => `${item.id}:${item.latestChapter ?? ''}:${item.cover ?? ''}:${item.title}`).join('|');
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private prepareCoverImages(items: Manga[], providerId: string, visibleCount: number): { visibleReady: Promise<void>; allReady: Promise<void> } {
        if (typeof Image === 'undefined' || items.length === 0) {
            const ready = Promise.resolve();
            return { visibleReady: ready, allReady: ready };
        }
        const startedAt = performance.now();
        const urls = items.map(item => api.coverProxyUrl(item.id, 'card', item.cover || undefined));
        let ok = 0;
        let failed = 0;
        const loads = urls.map(url => new Promise<void>(resolve => {
            const img = new Image();
            img.decoding = 'async';
            img.loading = 'eager';
            img.onload = () => {
                ok++;
                resolve();
            };
            img.onerror = () => {
                failed++;
                resolve();
            };
            img.src = url;
        }));
        const firstCount = Math.min(Math.max(1, visibleCount), loads.length);
        const visibleReady = Promise.allSettled(loads.slice(0, firstCount)).then(() => {
            this.log.emit('favorites-cover-ready', {
                providerId,
                phase: 'visible',
                count: firstCount,
                ok,
                failed,
                dtMs: Math.round(performance.now() - startedAt),
            });
        });
        const allReady = Promise.allSettled(loads).then(() => {
            this.log.emit('favorites-cover-ready', {
                providerId,
                phase: 'all',
                count: urls.length,
                ok,
                failed,
                dtMs: Math.round(performance.now() - startedAt),
            });
        });
        return { visibleReady, allReady };
    }

}
