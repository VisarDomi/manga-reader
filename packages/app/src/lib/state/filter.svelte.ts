import type { SearchFilters } from '@manga-reader/provider-types';
import * as storage from '../services/storage.js';

const STORAGE_KEY = 'filters';

interface PersistedFilters {
    terms: [string, 'include' | 'exclude'][];
    types: string[];
    statuses: string[];
}

let nsfwGenreIds = new Set<string>();

export function setNsfwGenreIds(ids: Set<string>): void {
    nsfwGenreIds = ids;
}

export function getNsfwGenreIds(): Set<string> {
    return nsfwGenreIds;
}

export class FilterState {
    termStates = $state<Map<string, 'include' | 'exclude'>>(new Map());
    selectedTypes = $state<Set<string>>(new Set());
    selectedStatuses = $state<Set<string>>(new Set());
    contentMode = $state<'sfw' | 'all'>(
        storage.getString('contentMode', 'sfw') as 'sfw' | 'all'
    );

    private onChange: () => void;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(onChange: () => void) {
        this.onChange = onChange;
        this.restore();
    }

    private debouncedOnChange(): void {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            this.onChange();
        }, 3000);
    }

    private persist(): void {
        const data: PersistedFilters = {
            terms: [...this.termStates.entries()],
            types: [...this.selectedTypes],
            statuses: [...this.selectedStatuses],
        };
        storage.setJson(STORAGE_KEY, data);
    }

    private restore(): void {
        const data = storage.getJson<PersistedFilters | null>(STORAGE_KEY, null);
        if (!data) return;
        if (Array.isArray(data.terms) && data.terms.length > 0) {
            // Backward compat: coerce numeric IDs to strings
            this.termStates = new Map(data.terms.map(([id, state]) => [String(id), state]));
        }
        if (Array.isArray(data.types) && data.types.length > 0) {
            this.selectedTypes = new Set(data.types);
        }
        if (Array.isArray(data.statuses) && data.statuses.length > 0) {
            this.selectedStatuses = new Set(data.statuses);
        }
    }

    get activeFilterCount(): number {
        return this.termStates.size + this.selectedTypes.size + this.selectedStatuses.size;
    }

    buildFilters(): SearchFilters | undefined {
        const includeGenres: string[] = [];
        const excludeGenres: string[] = [];
        for (const [id, state] of this.termStates) {
            if (state === 'include') includeGenres.push(id);
            else excludeGenres.push(id);
        }

        if (this.contentMode === 'sfw') {
            for (const id of nsfwGenreIds) {
                if (!includeGenres.includes(id) && !excludeGenres.includes(id)) {
                    excludeGenres.push(id);
                }
            }
        }

        const hasFilters = includeGenres.length > 0 || excludeGenres.length > 0
            || this.selectedTypes.size > 0 || this.selectedStatuses.size > 0;
        if (!hasFilters) return undefined;

        return {
            includeGenres,
            excludeGenres,
            types: [...this.selectedTypes],
            statuses: [...this.selectedStatuses],
        };
    }

    setContentMode(mode: 'sfw' | 'all') {
        this.contentMode = mode;
        storage.setString('contentMode', mode);
        this.debouncedOnChange();
    }

    toggleTerm(id: string) {
        const current = this.termStates.get(id);
        const next = new Map(this.termStates);
        if (!current) {
            next.set(id, 'include');
        } else if (current === 'include') {
            next.set(id, 'exclude');
        } else {
            next.delete(id);
        }
        this.termStates = next;
        this.persist();
        this.debouncedOnChange();
    }

    toggleType(type: string) {
        const next = new Set(this.selectedTypes);
        if (next.has(type)) next.delete(type);
        else next.add(type);
        this.selectedTypes = next;
        this.persist();
        this.debouncedOnChange();
    }

    toggleStatus(status: string) {
        const next = new Set(this.selectedStatuses);
        if (next.has(status)) next.delete(status);
        else next.add(status);
        this.selectedStatuses = next;
        this.persist();
        this.debouncedOnChange();
    }

    clear() {
        this.termStates = new Map();
        this.selectedTypes = new Set();
        this.selectedStatuses = new Set();
        this.persist();
        this.debouncedOnChange();
    }
}
