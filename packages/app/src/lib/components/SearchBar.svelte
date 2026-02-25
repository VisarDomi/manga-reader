<script lang="ts">
    import { appState } from '$lib/state/index.svelte.js';
    import FilterPanel from './FilterPanel.svelte';

    const favsActive = $derived(appState.favorites.isActive);

    function handleSubmit(e: Event) {
        e.preventDefault();
        if (favsActive) appState.favorites.deactivate();
        appState.ui.setView('list');
        appState.searchState.search(appState.searchState.inputQuery);
    }

    function toggleFavs() {
        if (favsActive) {
            appState.favorites.deactivate();
        } else {
            appState.favorites.activate();
            appState.ui.setView('list');
        }
    }

    $effect(() => {
        if (!appState.searchState.isLoading) {
            appState.searchState.inputQuery = appState.searchState.currentQuery;
        }
    });
</script>

<div class="search-bar-wrapper">
    <div class="action-row">
        <button
            class="action-btn"
            class:active={!favsActive}
            onclick={() => { if (favsActive) appState.favorites.deactivate(); }}
        >Search</button>
        <button
            class="action-btn"
            class:fav-active={favsActive}
            onclick={() => { if (!favsActive) { appState.favorites.activate(); appState.ui.setView('list'); } }}
        >Favs</button>
    </div>

    {#if !favsActive}
        <form class="input-container" onsubmit={handleSubmit}>
            <input
                type="text"
                placeholder="Search manga..."
                bind:value={appState.searchState.inputQuery}
                disabled={appState.searchState.isLoading}
            />
            {#if appState.searchState.isLoading}
                <div class="search-spinner"></div>
            {/if}
        </form>

        <div class="action-row">
            <button
                class="action-btn"
                class:sfw={appState.searchState.filters.contentMode === 'sfw'}
                class:nsfw={appState.searchState.filters.contentMode === 'all'}
                onclick={() => appState.searchState.filters.setContentMode(
                    appState.searchState.filters.contentMode === 'sfw' ? 'all' : 'sfw'
                )}
            >{appState.searchState.filters.contentMode === 'sfw' ? 'SFW' : 'All'}</button>
            {#if !appState.ui.filtersExpanded}
                <button
                    class="action-btn"
                    class:has-filters={appState.searchState.filters.activeFilterCount > 0}
                    onclick={() => appState.ui.filtersExpanded = true}
                >Filters{appState.searchState.filters.activeFilterCount > 0 ? ` (${appState.searchState.filters.activeFilterCount})` : ''}</button>
            {/if}
        </div>

        {#if appState.ui.filtersExpanded}
            <FilterPanel />
        {/if}
    {/if}
</div>

<style>
.search-bar-wrapper {
    margin: max(15px, env(safe-area-inset-top)) auto 0;
    width: 95%;
    max-width: 600px;
    background-color: rgba(30, 30, 30, 0.90);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.6);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.input-container {
    position: relative;
    width: 100%;
}

.input-container input {
    width: 100%;
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid #444;
    background: rgba(0, 0, 0, 0.3);
    color: #fff;
    font-size: 16px;
}

.input-container input:focus {
    outline: none;
    border-color: #777;
    background: rgba(0, 0, 0, 0.5);
}

.input-container input:disabled {
    opacity: 0.7;
    cursor: wait;
}

.search-spinner {
    position: absolute;
    right: 12px;
    top: 50%;
    transform: translateY(-50%);
    width: 18px;
    height: 18px;
    border: 2px solid rgba(255, 255, 255, 0.1);
    border-top-color: #4af626;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    pointer-events: none;
}

@keyframes spin {
    to { transform: translateY(-50%) rotate(360deg); }
}

.action-row {
    display: flex;
    gap: 8px;
}

.action-btn {
    flex: 1;
    padding: 8px 4px;
    background: #333;
    color: #ccc;
    border-radius: 6px;
    font-weight: 500;
    font-size: 16px;
    border: 1px solid #444;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    white-space: nowrap;
}

.action-btn:active {
    background: #555;
    color: #fff;
}

.action-btn.active {
    background: #0044cc;
    border-color: #0055ff;
    color: white;
}

.action-btn.fav-active {
    background: #3a1a1a;
    border-color: #f87171;
    color: #f87171;
}

.action-btn.sfw {
    background: #1a2a3a;
    border-color: #3b82f6;
    color: #3b82f6;
}

.action-btn.nsfw {
    background: #3a1a1a;
    border-color: #f87171;
    color: #f87171;
}

.action-btn.has-filters {
    background: #1a3a1a;
    border-color: #4ade80;
    color: #4ade80;
}
</style>
