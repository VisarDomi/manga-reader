import type { SearchFilters } from '@manga-reader/provider-types';
import * as storage from '../services/storage.js';

const STORAGE_KEY = 'filters';

interface PersistedFilters {
    terms: [string, 'include' | 'exclude'][];
    types: string[];
    statuses: string[];
}

export class FilterState {
    termStates = $state<Map<string, 'include' | 'exclude'>>(new Map());
    selectedTypes = $state<Set<string>>(new Set());
    selectedStatuses = $state<Set<string>>(new Set());

    private onChange: () => void;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private initialized = false;

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
        // Clean up orphaned key from previous contentMode toggle
        storage.remove('contentMode');

        const data = storage.getJson<PersistedFilters | null>(STORAGE_KEY, null);
        if (!data) return;
        this.initialized = true;
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

    /** Seed NSFW genres as excluded on first install. No-op if already initialized. */
    seedDefaults(nsfwIds: Set<string>): void {
        if (this.initialized) return;
        this.initialized = true;
        const terms = new Map(this.termStates);
        for (const id of nsfwIds) {
            terms.set(id, 'exclude');
        }
        this.termStates = terms;
        this.persist();
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

    restoreFromContext(filters: SearchFilters | undefined): void {
        if (!filters) {
            this.termStates = new Map();
            this.selectedTypes = new Set();
            this.selectedStatuses = new Set();
        } else {
            const terms = new Map<string, 'include' | 'exclude'>();
            for (const id of filters.includeGenres ?? []) terms.set(id, 'include');
            for (const id of filters.excludeGenres ?? []) {
                terms.set(id, 'exclude');
            }
            this.termStates = terms;
            this.selectedTypes = new Set(filters.types ?? []);
            this.selectedStatuses = new Set(filters.statuses ?? []);
        }
        this.persist();
    }

    clear() {
        this.termStates = new Map();
        this.selectedTypes = new Set();
        this.selectedStatuses = new Set();
        this.persist();
        this.debouncedOnChange();
    }
}
