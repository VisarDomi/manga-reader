import type { ChapterMeta } from '../types.js';
import * as storage from '../services/storage.js';
import { getProviderId } from '../services/provider.js';
import type { GroupFilterState } from './groupFilter.svelte.js';

interface ChapterStatsEntry {
    key: string;
    upstreamMax: number | null;
    filteredMax: number;
    updatedAt: number;
}

export interface ChapterStatsSnapshot {
    filteredMax: number | null;
}

export class ChapterStatsState {
    private entries = $state<Record<string, ChapterStatsEntry>>({});
    private gf: GroupFilterState;
    private listeners = new Map<string, Set<() => void>>();

    constructor(gf: GroupFilterState) {
        this.gf = gf;
    }

    keyFor(mangaId: string, selectedGroups?: Set<string>): string {
        const selected = selectedGroups ?? new Set(storage.getJson<string[]>(`group:${getProviderId()}:${mangaId}`, []));
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

    snapshot(mangaId: string, upstreamMax: number | null): ChapterStatsSnapshot {
        return {
            filteredMax: this.getFilteredMax(mangaId, upstreamMax),
        };
    }

    needsRefresh(mangaId: string, upstreamMax: number | null): boolean {
        const entry = this.entries[mangaId];
        return !entry || entry.key !== this.keyFor(mangaId) || entry.upstreamMax !== upstreamMax;
    }

    update(mangaId: string, upstreamMax: number | null, chapters: ChapterMeta[], selectedGroups?: Set<string>): void {
        const selected = selectedGroups ?? new Set(storage.getJson<string[]>(`group:${getProviderId()}:${mangaId}`, []));
        const filteredByBlock = this.gf.count === 0
            ? chapters
            : chapters.filter(ch => !this.gf.isFiltered(ch.groupId ?? ''));

        const source = selected.size === 0
            ? filteredByBlock
            : filteredByBlock.filter(ch => selected.has(ch.groupId ?? ''));

        const filteredMax = source.reduce((max, ch) => Math.max(max, Number.isFinite(ch.number) ? ch.number : 0), 0);
        this.entries[mangaId] = {
            key: this.keyFor(mangaId, selected),
            upstreamMax,
            filteredMax,
            updatedAt: Date.now(),
        };
        this.notify(mangaId);
    }

    invalidateAll(): void {
        this.entries = {};
        for (const mangaId of this.listeners.keys()) this.notify(mangaId);
    }

    subscribe(mangaId: string, callback: () => void): () => void {
        let listeners = this.listeners.get(mangaId);
        if (!listeners) {
            listeners = new Set();
            this.listeners.set(mangaId, listeners);
        }
        listeners.add(callback);
        callback();
        return () => {
            listeners?.delete(callback);
            if (listeners?.size === 0) this.listeners.delete(mangaId);
        };
    }

    private notify(mangaId: string): void {
        const listeners = this.listeners.get(mangaId);
        if (!listeners) return;
        for (const listener of listeners) listener();
    }
}
