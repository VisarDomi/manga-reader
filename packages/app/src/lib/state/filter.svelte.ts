import type { SearchFilters } from '@manga-reader/provider-types';
import type { FilterDefinition } from '@manga-reader/provider-types';
import { Filter } from '../logic.js';
import { SEARCH_DEBOUNCE_MS } from '../constants.js';
import * as storage from '../services/storage.js';

const LEGACY_STORAGE_KEY = 'filters';

interface PersistedFilters {
    terms: [string, 'include' | 'exclude'][];
    demographics?: string[];
    authors?: string[];
    artists?: string[];
    authorLabels?: [string, string][];
    artistLabels?: [string, string][];
    termLabels?: [string, string][];
    types: string[];
    statuses: string[];
}

export class FilterState {
    termStates = $state<Map<string, 'include' | 'exclude'>>(new Map());
    selectedDemographics = $state<Set<string>>(new Set());
    selectedAuthors = $state<Set<string>>(new Set());
    selectedArtists = $state<Set<string>>(new Set());
    authorLabels = $state<Map<string, string>>(new Map());
    artistLabels = $state<Map<string, string>>(new Map());
    termLabels = $state<Map<string, string>>(new Map());
    selectedTypes = $state<Set<string>>(new Set());
    selectedStatuses = $state<Set<string>>(new Set());

    private onChange: () => void;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private initialized = false;
    private demographicIds = new Set<string>();
    private termIds = new Set<string>();
    private providerId = 'comix';

    constructor(onChange: () => void, providerId = 'comix') {
        this.onChange = onChange;
        this.providerId = providerId;
        this.restore();
    }

    setProvider(providerId: string, forceRestore = false): void {
        const normalized = providerId || 'comix';
        if (normalized === this.providerId && !forceRestore) return;
        this.providerId = normalized;
        this.demographicIds = new Set();
        this.termIds = new Set();
        this.restore();
    }

    private storageKey(): string {
        return `filters:${this.providerId}`;
    }

    private debouncedOnChange(): void {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            this.onChange();
        }, SEARCH_DEBOUNCE_MS);
    }

    cancelDebounce(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
    }

    private persist(): void {
        const data: PersistedFilters = {
            terms: [...this.termStates.entries()],
            demographics: [...this.selectedDemographics],
            authors: [...this.selectedAuthors],
            artists: [...this.selectedArtists],
            authorLabels: [...this.authorLabels.entries()],
            artistLabels: [...this.artistLabels.entries()],
            termLabels: [...this.termLabels.entries()],
            types: [...this.selectedTypes],
            statuses: [...this.selectedStatuses],
        };
        storage.setJson(this.storageKey(), data);
    }

    private restore(): void {
        storage.remove('contentMode');

        this.termStates = new Map();
        this.selectedDemographics = new Set();
        this.selectedAuthors = new Set();
        this.selectedArtists = new Set();
        this.authorLabels = new Map();
        this.artistLabels = new Map();
        this.termLabels = new Map();
        this.selectedTypes = new Set();
        this.selectedStatuses = new Set();
        this.initialized = false;

        let data = storage.getJson<PersistedFilters | null>(this.storageKey(), null);
        if (!data && this.providerId === 'comix') {
            data = storage.getJson<PersistedFilters | null>(LEGACY_STORAGE_KEY, null);
            if (data) {
                storage.setJson(this.storageKey(), data);
                storage.remove(LEGACY_STORAGE_KEY);
            }
        }
        if (!data) return;
        this.initialized = true;
        if (Array.isArray(data.terms) && data.terms.length > 0) {
            this.termStates = new Map(data.terms.map(([id, state]) => [String(id), state]));
        }
        if (Array.isArray(data.demographics) && data.demographics.length > 0) {
            this.selectedDemographics = new Set(data.demographics.map(String));
        }
        if (Array.isArray(data.authors) && data.authors.length > 0) {
            this.selectedAuthors = new Set(data.authors.map(String));
        }
        if (Array.isArray(data.artists) && data.artists.length > 0) {
            this.selectedArtists = new Set(data.artists.map(String));
        }
        if (Array.isArray(data.authorLabels)) this.authorLabels = new Map(data.authorLabels.map(([id, name]) => [String(id), String(name)]));
        if (Array.isArray(data.artistLabels)) this.artistLabels = new Map(data.artistLabels.map(([id, name]) => [String(id), String(name)]));
        if (Array.isArray(data.termLabels)) this.termLabels = new Map(data.termLabels.map(([id, name]) => [String(id), String(name)]));
        if (Array.isArray(data.types) && data.types.length > 0) {
            this.selectedTypes = new Set(data.types);
        }
        if (Array.isArray(data.statuses) && data.statuses.length > 0) {
            this.selectedStatuses = new Set(data.statuses);
        }
    }

    configureDefinitions(filters: FilterDefinition): void {
        this.demographicIds = new Set((filters.demographics ?? []).map(item => item.id));
        this.termIds = new Set(filters.genres.map(item => item.id));
        this.termLabels = new Map([
            ...this.termLabels,
            ...filters.genres.map(item => [item.id, item.name] as const),
        ]);

        let changed = false;
        const nextTerms = new Map<string, 'include' | 'exclude'>();
        const nextDemographics = new Set(this.selectedDemographics);

        for (const [id, state] of this.termStates) {
            if (this.demographicIds.has(id)) {
                if (state === Filter.INCLUDE) nextDemographics.add(id);
                changed = true;
                continue;
            }
            if (this.termIds.has(id)) {
                nextTerms.set(id, state);
            } else {
                changed = true;
            }
        }

        for (const id of nextDemographics) {
            if (!this.demographicIds.has(id)) {
                nextDemographics.delete(id);
                changed = true;
            }
        }

        if (changed || nextTerms.size !== this.termStates.size || nextDemographics.size !== this.selectedDemographics.size) {
            this.termStates = nextTerms;
            this.selectedDemographics = nextDemographics;
            this.persist();
        }
    }

    seedDefaults(nsfwIds: Set<string>): void {
        if (this.initialized) return;
        this.initialized = true;
        const terms = new Map(this.termStates);
        for (const id of nsfwIds) {
            terms.set(id, Filter.EXCLUDE);
        }
        this.termStates = terms;
        this.persist();
    }

    get activeFilterCount(): number {
        return this.termStates.size + this.selectedDemographics.size + this.selectedAuthors.size + this.selectedArtists.size + this.selectedTypes.size + this.selectedStatuses.size;
    }

    buildFilters(): SearchFilters | undefined {
        const includeGenres: string[] = [];
        const excludeGenres: string[] = [];
        for (const [id, state] of this.termStates) {
            if (state === Filter.INCLUDE) includeGenres.push(id);
            else excludeGenres.push(id);
        }

        const hasFilters = includeGenres.length > 0 || excludeGenres.length > 0
            || this.selectedDemographics.size > 0 || this.selectedAuthors.size > 0 || this.selectedArtists.size > 0
            || this.selectedTypes.size > 0 || this.selectedStatuses.size > 0;
        if (!hasFilters) return undefined;

        return {
            includeGenres,
            excludeGenres,
            demographics: [...this.selectedDemographics],
            authors: [...this.selectedAuthors],
            artists: [...this.selectedArtists],
            types: [...this.selectedTypes],
            statuses: [...this.selectedStatuses],
        };
    }

    addTag(id: string, name: string) {
        const labels = new Map(this.termLabels);
        labels.set(id, name);
        this.termLabels = labels;
        if (!this.termStates.has(id)) this.toggleTerm(id);
        else this.persist();
    }

    removeTerm(id: string) {
        const next = new Map(this.termStates);
        next.delete(id);
        this.termStates = next;
        this.persist();
        this.debouncedOnChange();
    }

    addAuthor(id: string, name: string) {
        const labels = new Map(this.authorLabels);
        labels.set(id, name);
        this.authorLabels = labels;
        const next = new Set(this.selectedAuthors);
        next.add(id);
        this.selectedAuthors = next;
        this.persist();
        this.debouncedOnChange();
    }

    removeAuthor(id: string) {
        const next = new Set(this.selectedAuthors);
        next.delete(id);
        this.selectedAuthors = next;
        this.persist();
        this.debouncedOnChange();
    }

    addArtist(id: string, name: string) {
        const labels = new Map(this.artistLabels);
        labels.set(id, name);
        this.artistLabels = labels;
        const next = new Set(this.selectedArtists);
        next.add(id);
        this.selectedArtists = next;
        this.persist();
        this.debouncedOnChange();
    }

    removeArtist(id: string) {
        const next = new Set(this.selectedArtists);
        next.delete(id);
        this.selectedArtists = next;
        this.persist();
        this.debouncedOnChange();
    }

    toggleDemographic(id: string) {
        const next = new Set(this.selectedDemographics);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        this.selectedDemographics = next;
        this.persist();
        this.debouncedOnChange();
    }

    toggleTerm(id: string) {
        const current = this.termStates.get(id);
        const next = new Map(this.termStates);
        if (!current) {
            next.set(id, Filter.INCLUDE);
        } else if (current === Filter.INCLUDE) {
            next.set(id, Filter.EXCLUDE);
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
            this.selectedDemographics = new Set();
            this.selectedAuthors = new Set();
            this.selectedArtists = new Set();
            this.selectedTypes = new Set();
            this.selectedStatuses = new Set();
        } else {
            const terms = new Map<string, 'include' | 'exclude'>();
            for (const id of filters.includeGenres ?? []) terms.set(id, Filter.INCLUDE);
            for (const id of filters.excludeGenres ?? []) {
                terms.set(id, Filter.EXCLUDE);
            }
            this.termStates = terms;
            this.selectedDemographics = new Set(filters.demographics ?? []);
            this.selectedAuthors = new Set(filters.authors ?? []);
            this.selectedArtists = new Set(filters.artists ?? []);
            this.selectedTypes = new Set(filters.types ?? []);
            this.selectedStatuses = new Set(filters.statuses ?? []);
        }
        this.persist();
    }

    clear() {
        this.termStates = new Map();
        this.selectedDemographics = new Set();
        this.selectedAuthors = new Set();
        this.selectedArtists = new Set();
        this.selectedTypes = new Set();
        this.selectedStatuses = new Set();
        this.persist();
        this.debouncedOnChange();
    }
}
