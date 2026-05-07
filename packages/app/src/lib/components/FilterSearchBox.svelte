<script lang="ts">
    import { searchProviderFilters, type ProviderFilterSearchOption } from '$lib/services/provider.js';
    import FilterChip from './FilterChip.svelte';

    let {
        label,
        type,
        selected,
        labels,
        onadd,
        onremove,
    }: {
        label: string;
        type: 'tag' | 'author' | 'artist';
        selected: Set<string>;
        labels: Map<string, string>;
        onadd: (id: string, name: string) => void;
        onremove: (id: string) => void;
    } = $props();

    let query = $state('');
    let results = $state<ProviderFilterSearchOption[]>([]);
    let loading = $state(false);
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function scheduleSearch(value: string) {
        query = value;
        if (timer) clearTimeout(timer);
        controller?.abort();
        const trimmed = value.trim();
        if (trimmed.length < 2) {
            results = [];
            loading = false;
            return;
        }
        loading = true;
        timer = setTimeout(() => {
            controller = new AbortController();
            searchProviderFilters(type, trimmed, controller.signal)
                .then(items => { results = items; })
                .catch(() => { if (!controller?.signal.aborted) results = []; })
                .finally(() => { loading = false; });
        }, 250);
    }

    function add(item: ProviderFilterSearchOption) {
        onadd(item.id, item.name);
        query = '';
        results = [];
    }
</script>

<div class="filter-search-box">
    <span class="filter-label">{label}</span>
    <div class="selected-chips">
        {#each [...selected] as id (id)}
            <FilterChip
                label={labels.get(id) ?? id}
                active
                onclick={() => onremove(id)}
            />
        {/each}
    </div>
    <input
        class="filter-search-input"
        type="search"
        placeholder="Search..."
        value={query}
        oninput={(e) => scheduleSearch(e.currentTarget.value)}
    />
    {#if loading || results.length > 0}
        <div class="filter-search-results">
            {#if loading}
                <span class="filter-search-empty">Searching...</span>
            {:else}
                {#each results as item (item.id)}
                    <button class="filter-search-result" onclick={() => add(item)}>
                        {item.name}
                    </button>
                {/each}
            {/if}
        </div>
    {/if}
</div>

<style>
.filter-search-box {
    margin-bottom: 10px;
}

.selected-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-bottom: 6px;
}

.filter-search-input {
    width: 100%;
    min-height: 38px;
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid #333;
    background: #111;
    color: #ddd;
    font-size: 16px;
}

.filter-search-results {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    padding-top: 6px;
}

.filter-search-result {
    padding: 5px 10px;
    border-radius: 6px;
    background: #1a1a1a;
    color: #bbb;
    border: 1px solid #333;
    font-size: 14px;
}

.filter-search-empty {
    color: #777;
    font-size: 13px;
}
</style>
