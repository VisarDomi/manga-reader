import type { ChapterMeta } from '../types.js';
import * as storage from '../services/storage.js';
import type { GroupFilterState } from './groupFilter.svelte.js';

const STORAGE_KEY = 'chapterStats:v1';

interface ChapterStatsEntry {
    key: string;
    upstreamMax: number | null;
    filteredMax: number;
    updatedAt: number;
}

export class ChapterStatsState {
    private entries = $state<Record<string, ChapterStatsEntry>>({});
    private loading = $state<Record<string, string>>({});
    private gf: GroupFilterState;

    constructor(gf: GroupFilterState) {
        this.gf = gf;
        this.entries = storage.getJson<Record<string, ChapterStatsEntry>>(STORAGE_KEY, {});
    }

    keyFor(mangaId: string, selectedGroups?: Set<string>): string {
        const selected = selectedGroups ?? new Set(storage.getJson<string[]>(`group:${mangaId}`, []));
        return [
            `blocked:${this.gf.key}`,
            `selected:${[...selected].sort().join(',')}`,
        ].join('|');
    }

    getFilteredMax(mangaId: string, upstreamMax: number | null): number | null {
        const entry = this.entries[mangaId];
        if (!entry || entry.key !== this.keyFor(mangaId) || entry.upstreamMax !== upstreamMax) return null;
        return entry.filteredMax;
    }

    isLoading(mangaId: string, upstreamMax: number | null): boolean {
        return this.loading[mangaId] === this.keyFor(mangaId) && this.needsRefresh(mangaId, upstreamMax);
    }

    needsRefresh(mangaId: string, upstreamMax: number | null): boolean {
        const entry = this.entries[mangaId];
        return !entry || entry.key !== this.keyFor(mangaId) || entry.upstreamMax !== upstreamMax;
    }

    markLoading(mangaId: string): void {
        this.loading[mangaId] = this.keyFor(mangaId);
    }

    clearLoading(mangaId: string): void {
        delete this.loading[mangaId];
    }

    update(mangaId: string, upstreamMax: number | null, chapters: ChapterMeta[], selectedGroups: Set<string>): void {
        const filteredByBlock = this.gf.count === 0
            ? chapters
            : chapters.filter(ch => !this.gf.isFiltered(ch.groupId ?? ''));

        const source = selectedGroups.size === 0
            ? filteredByBlock
            : filteredByBlock.filter(ch => selectedGroups.has(ch.groupId ?? ''));

        const filteredMax = source.reduce((max, ch) => Math.max(max, Number.isFinite(ch.number) ? ch.number : 0), 0);
        this.entries[mangaId] = {
            key: this.keyFor(mangaId, selectedGroups),
            upstreamMax,
            filteredMax,
            updatedAt: Date.now(),
        };
        storage.setJson(STORAGE_KEY, $state.snapshot(this.entries));
        this.clearLoading(mangaId);
    }
}
