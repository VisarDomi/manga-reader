<script lang="ts">
    import { appState } from '$lib/state/index.svelte.js';
    import { TERMS, TERM_CATEGORIES, TYPES, STATUSES, STATUS_LABELS, TYPE_LABELS, NSFW_TERM_IDS } from '$lib/data/terms.js';
    import FilterChip from './FilterChip.svelte';

    const NSFW_IDS = new Set<number>(NSFW_TERM_IDS);

    const termsByCategory = TERM_CATEGORIES.map(cat => ({
        ...cat,
        terms: TERMS.filter(t => t.category === cat.key),
    }));

    const effectiveStates = $derived.by(() => {
        const map = new Map<number, 'include' | 'exclude'>();
        for (const term of TERMS) {
            const explicit = appState.searchState.filters.termStates.get(term.id);
            if (explicit) { map.set(term.id, explicit); continue; }
            if (appState.searchState.filters.contentMode === 'sfw' && NSFW_IDS.has(term.id))
                map.set(term.id, 'exclude');
        }
        return map;
    });

    const prefixes = $derived.by(() => {
        const map = new Map<number, string>();
        for (const [id, state] of effectiveStates) {
            map.set(id, state === 'include' ? '+' : '\u2212');
        }
        return map;
    });
</script>

<div class="filter-panel">
    <!-- Collapse button row -->
    <div class="filter-header">
        <button class="filter-collapse" onclick={() => appState.ui.filtersExpanded = false}>
            Collapse
        </button>
        {#if appState.searchState.filters.activeFilterCount > 0}
            <button class="filter-clear" onclick={() => appState.searchState.filters.clear()}>
                Clear All ({appState.searchState.filters.activeFilterCount})
            </button>
        {/if}
    </div>

    <!-- Type -->
    <div class="filter-section">
        <span class="filter-label">Type</span>
        <div class="filter-chips">
            {#each TYPES as t}
                <FilterChip
                    label={TYPE_LABELS[t]}
                    active={appState.searchState.filters.selectedTypes.has(t)}
                    onclick={() => appState.searchState.filters.toggleType(t)}
                />
            {/each}
        </div>
    </div>

    <!-- Status -->
    <div class="filter-section">
        <span class="filter-label">Status</span>
        <div class="filter-chips">
            {#each STATUSES as s}
                <FilterChip
                    label={STATUS_LABELS[s]}
                    active={appState.searchState.filters.selectedStatuses.has(s)}
                    onclick={() => appState.searchState.filters.toggleStatus(s)}
                />
            {/each}
        </div>
    </div>

    <!-- Term categories: Demographics, Genres, Themes, Formats -->
    {#each termsByCategory as cat}
        <div class="filter-section">
            <span class="filter-label">{cat.label}</span>
            <div class="filter-chips">
                {#each cat.terms as term}
                    <FilterChip
                        label={`${(prefixes.get(term.id) ?? '')}${term.name}`}
                        included={effectiveStates.get(term.id) === 'include'}
                        excluded={effectiveStates.get(term.id) === 'exclude'}
                        onclick={() => appState.searchState.filters.toggleTerm(term.id)}
                    />
                {/each}
            </div>
        </div>
    {/each}
</div>

<style>
.filter-panel {
    padding: 8px 0 0;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.filter-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
}

.filter-collapse {
    font-size: 12px;
    color: #888;
    padding: 4px 0;
}

.filter-collapse:active {
    color: #fff;
}

.filter-section {
    margin-bottom: 10px;
}

.filter-label {
    display: block;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #666;
    margin-bottom: 6px;
}

.filter-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
}

.filter-clear {
    display: block;
    margin-left: auto;
    padding: 6px 12px;
    font-size: 12px;
    color: #888;
    background: none;
    border: none;
}

.filter-clear:active {
    color: #fff;
}
</style>
