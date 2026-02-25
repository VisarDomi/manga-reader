<script lang="ts">
    import { appState } from '$lib/state/index.svelte.js';
    import { getProvider } from '$lib/services/provider.js';
    import { getNsfwGenreIds } from '$lib/state/filter.svelte.js';
    import FilterChip from './FilterChip.svelte';

    const filterDef = getProvider().getFilters();
    const nsfwIds = getNsfwGenreIds();

    // Group genres by their group field (demographic, genre, theme, format)
    const genresByGroup = $derived.by(() => {
        const map = new Map<string, typeof filterDef.genres>();
        for (const g of filterDef.genres) {
            const group = g.group ?? 'other';
            const arr = map.get(group);
            if (arr) arr.push(g);
            else map.set(group, [g]);
        }
        return map;
    });

    const GROUP_LABELS: Record<string, string> = {
        demographic: 'Demographics',
        genre: 'Genres',
        theme: 'Themes',
        format: 'Formats',
    };

    const effectiveStates = $derived.by(() => {
        const map = new Map<string, 'include' | 'exclude'>();
        for (const g of filterDef.genres) {
            const explicit = appState.searchState.filters.termStates.get(g.id);
            if (explicit) { map.set(g.id, explicit); continue; }
            if (appState.searchState.filters.contentMode === 'sfw' && nsfwIds.has(g.id))
                map.set(g.id, 'exclude');
        }
        return map;
    });

    const prefixes = $derived.by(() => {
        const map = new Map<string, string>();
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
    {#if filterDef.types && filterDef.types.length > 0}
        <div class="filter-section">
            <span class="filter-label">Type</span>
            <div class="filter-chips">
                {#each filterDef.types as t (t.id)}
                    <FilterChip
                        label={t.name}
                        active={appState.searchState.filters.selectedTypes.has(t.id)}
                        onclick={() => appState.searchState.filters.toggleType(t.id)}
                    />
                {/each}
            </div>
        </div>
    {/if}

    <!-- Status -->
    {#if filterDef.statuses && filterDef.statuses.length > 0}
        <div class="filter-section">
            <span class="filter-label">Status</span>
            <div class="filter-chips">
                {#each filterDef.statuses as s (s.id)}
                    <FilterChip
                        label={s.name}
                        active={appState.searchState.filters.selectedStatuses.has(s.id)}
                        onclick={() => appState.searchState.filters.toggleStatus(s.id)}
                    />
                {/each}
            </div>
        </div>
    {/if}

    <!-- Genre categories -->
    {#each [...genresByGroup] as [groupKey, genres] (groupKey)}
        <div class="filter-section">
            <span class="filter-label">{GROUP_LABELS[groupKey] ?? groupKey}</span>
            <div class="filter-chips">
                {#each genres as genre (genre.id)}
                    <FilterChip
                        label={`${(prefixes.get(genre.id) ?? '')}${genre.name}`}
                        included={effectiveStates.get(genre.id) === 'include'}
                        excluded={effectiveStates.get(genre.id) === 'exclude'}
                        onclick={() => appState.searchState.filters.toggleTerm(genre.id)}
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
