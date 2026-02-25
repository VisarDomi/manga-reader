<script lang="ts">
    import { appState } from '$lib/state/index.svelte.js';
    import { sentinel } from '$lib/actions/sentinel.js';
    import { SENTINEL_ROOT_MARGIN } from '$lib/constants.js';
    import SearchBar from '$lib/components/SearchBar.svelte';
    import MangaList from '$lib/components/MangaList.svelte';

    const favsActive = $derived(appState.favorites.isActive);
    const favsItems = $derived(appState.favorites.items);
    const favsLoading = $derived(appState.favorites.isLoading);
    const results = $derived(appState.searchState.results);
    const total = $derived(results.length);
    const query = $derived(appState.searchState.currentQuery);
    const isLoading = $derived(appState.searchState.isLoading);
    const hasMore = $derived(appState.searchState.hasMore);
</script>

<SearchBar />

<div class="content-wrapper">
    {#if favsActive}
        <div class="results-info">
            <span class="count">{favsItems.length}</span> favorites
        </div>

        {#if favsLoading}
            <div class="empty">Loading...</div>
        {:else if favsItems.length === 0}
            <div class="empty">No favorites yet</div>
        {:else}
            <MangaList manga={favsItems} />
        {/if}
    {:else}
        {#if total > 0 || query}
            <div class="results-info">
                <span class="count">{total}</span> results
                {#if query}
                    <span class="query">{query}</span>
                {/if}
            </div>
        {/if}

        <MangaList manga={results} />

        {#if hasMore}
            <div class="sentinel" use:sentinel={{
                getRoot: () => document.getElementById('view-list'),
                rootMargin: SENTINEL_ROOT_MARGIN,
                onIntersect: () => { appState.searchState.loadNextPage(); },
                disabled: isLoading,
                generation: appState.ui.listViewGeneration
            }}></div>
        {:else}
            <!-- [DBG] sentinel hidden: hasMore=false -->
        {/if}

        {#if isLoading}
            <div class="empty">Loading...</div>
        {:else if total === 0}
            <div class="empty">No results</div>
        {/if}
    {/if}
</div>

<style>
.content-wrapper {
    padding-bottom: max(20px, env(safe-area-inset-bottom));
}

.results-info {
    background: #111;
    border: 1px solid #333;
    padding: 10px;
    margin: 0 10px 15px 10px;
    border-radius: 4px;
    color: #aaa;
    font-size: 14px;
    display: flex;
    gap: 15px;
    align-items: center;
}

.results-info .count {
    color: #fff;
    font-weight: bold;
}

.results-info .query {
    font-family: monospace;
    color: #4af626;
    font-size: 16px;
}
</style>
