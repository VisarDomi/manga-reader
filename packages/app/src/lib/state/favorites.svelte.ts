import * as db from '../services/db.js';
import * as api from '../services/api.js';
import type { LogService } from '../services/LogService.js';
import { Msg } from '../messages.js';
import type { Manga } from '../types.js';
import type { ChapterStatsState } from './chapterStats.svelte.js';
import type { ToastState } from './toast.svelte.js';

export class FavoritesState {
    items = $state<Manga[]>([]);
    ids = $state<string[]>([]);
    isLoading = $state(false);
    private hydrationGeneration = 0;
    private loaded = false;
    private rows: db.FavoriteIdRow[] = [];
    private hydrationInFlight = false;
    private snapshotsHydrated = false;

    private toast: ToastState;
    private log: LogService;
    private chapterStats: ChapterStatsState;

    constructor(toast: ToastState, log: LogService, chapterStats: ChapterStatsState) {
        this.toast = toast;
        this.log = log;
        this.chapterStats = chapterStats;
    }

    async init(options?: { hydrate?: boolean }) {
        try {
            await this.loadFavoriteRows({ hydrate: options?.hydrate !== false });
            this.loaded = true;
        } catch {
            this.toast.show(Msg.STORAGE_UNAVAILABLE);
        }
    }

    isFavorited(id: string): boolean {
        return this.ids.includes(id);
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
                await db.removeFavorite(manga.id);
                this.toast.show('Removed from favorites');
            } else {
                await db.addFavorite(manga);
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
        if (this.loaded) {
            this.hydrateSnapshots('activate');
            return;
        }
        this.isLoading = true;
        try {
            await this.loadFavoriteRows({ hydrate: true });
            this.loaded = true;
        } catch {
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

    hydrateSnapshots(reason = 'background'): void {
        if (!this.loaded || this.rows.length === 0) return;
        if (this.hydrationInFlight || this.snapshotsHydrated) return;
        this.hydrationGeneration++;
        const generation = this.hydrationGeneration;
        this.hydrationInFlight = true;
        void this.refreshFavoriteSnapshots(this.rows, generation);
        this.log.emit('foreground-work', {
            owner: 'favorites',
            action: 'run',
            view: 'favorites',
            reason,
            count: this.rows.length,
        });
    }

    private async loadFavoriteRows(options?: { hydrate?: boolean }): Promise<void> {
        const rows = await db.getAllFavoriteRows();
        this.rows = rows;
        this.snapshotsHydrated = false;
        this.hydrationGeneration++;
        const generation = this.hydrationGeneration;
        this.ids = rows.map(row => row.id);
        this.items = rows.map(row => this.items.find(item => item.id === row.id) ?? this.placeholder(row.id, row.snapshot));
        if (rows.length === 0) return;
        if (options?.hydrate === false) {
            this.log.emit('favorites-hydration', {
                phase: 'deferred',
                total: rows.length,
                batchSize: rows.length,
                dtMs: 0,
            });
            return;
        }
        this.hydrationInFlight = true;
        void this.refreshFavoriteSnapshots(rows, generation);
    }

    private async refreshFavoriteSnapshots(rows: db.FavoriteIdRow[], generation: number): Promise<void> {
        const startedAt = performance.now();
        const fallbacks = rows.map(row => this.items.find(item => item.id === row.id) ?? this.placeholder(row.id, row.snapshot));
        this.log.emit('favorites-hydration', {
            phase: 'start',
            total: rows.length,
            batchSize: rows.length,
            dtMs: 0,
        });

        const batchStartedAt = performance.now();
        const count = await this.repairCardSnapshots(fallbacks, generation);
        if (count == null) {
            if (generation === this.hydrationGeneration) this.hydrationInFlight = false;
            this.log.emit('favorites-hydration', {
                phase: 'cancelled',
                total: rows.length,
                batchSize: rows.length,
                batchIndex: 0,
                count: 0,
                dtMs: Math.round(performance.now() - startedAt),
            });
            return;
        }
        this.log.emit('favorites-hydration', {
            phase: 'batch',
            total: rows.length,
            batchSize: rows.length,
            batchIndex: 0,
            count,
            dtMs: Math.round(performance.now() - batchStartedAt),
        });

        this.log.emit('favorites-hydration', {
            phase: 'done',
            total: rows.length,
            batchSize: rows.length,
            dtMs: Math.round(performance.now() - startedAt),
        });
        if (generation === this.hydrationGeneration) {
            this.hydrationInFlight = false;
            this.snapshotsHydrated = true;
        }
    }

    private async repairCardSnapshots(fallbacks: Manga[], generation: number): Promise<number | null> {
        const snapshots = await api.fetchMangaCardSnapshots(fallbacks, undefined, true).catch(() => []);
        if (generation !== this.hydrationGeneration) return null;

        const activeIds = new Set(this.ids);
        const hydrated = snapshots.filter(snapshot => activeIds.has(snapshot.manga.id));
        if (hydrated.length === 0) return 0;

        const byId = new Map(hydrated.map(result => [result.manga.id, result.manga]));
        this.items = this.items.map(item => byId.get(item.id) ?? item);
        for (const result of hydrated) {
            void db.updateFavoriteSnapshot(result.manga);
            if (!result.chapters) continue;
            this.chapterStats.update(result.manga.id, result.manga.latestChapter ?? null, result.chapters);
        }
        return hydrated.length;
    }

    refreshChapterStats(): void {
        const generation = this.hydrationGeneration;
        void api.fetchMangaCardSnapshots(this.items, undefined, true)
            .then(snapshots => {
                if (generation !== this.hydrationGeneration) return;
                for (const result of snapshots) {
                    if (!result.chapters) continue;
                    this.chapterStats.update(result.manga.id, result.manga.latestChapter ?? null, result.chapters);
                }
            })
            .catch(() => {});
    }

}
