import type { SearchFilters } from '../services/api.js';
import * as storage from '../services/storage.js';
import { NSFW_TERM_IDS } from '../data/terms.js';

const STORAGE_KEY = 'filters';

interface PersistedFilters {
    terms: [number, 'include' | 'exclude'][];
    types: string[];
    statuses: string[];
}

export class FilterState {
    termStates = $state<Map<number, 'include' | 'exclude'>>(new Map());
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
            this.termStates = new Map(data.terms);
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
        const includeTerms: number[] = [];
        const excludeTerms: number[] = [];
        for (const [id, state] of this.termStates) {
            if (state === 'include') includeTerms.push(id);
            else excludeTerms.push(id);
        }

        if (this.contentMode === 'sfw') {
            for (const id of NSFW_TERM_IDS) {
                if (!includeTerms.includes(id) && !excludeTerms.includes(id)) {
                    excludeTerms.push(id);
                }
            }
        }

        const hasFilters = includeTerms.length > 0 || excludeTerms.length > 0
            || this.selectedTypes.size > 0 || this.selectedStatuses.size > 0;
        if (!hasFilters) return undefined;

        return {
            includeTerms,
            excludeTerms,
            types: [...this.selectedTypes],
            statuses: [...this.selectedStatuses],
        };
    }

    setContentMode(mode: 'sfw' | 'all') {
        this.contentMode = mode;
        storage.setString('contentMode', mode);
        this.debouncedOnChange();
    }

    toggleTerm(id: number) {
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
