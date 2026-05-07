<script lang="ts">
    import { appState } from '$lib/state/index.svelte.js';
    import { swipeBack } from '$lib/actions/swipeBack.js';
    import SearchBar from '$lib/components/SearchBar.svelte';
    import MangaList from '$lib/components/MangaList.svelte';

    const favsItems = $derived(appState.favorites.items);
    const favsLoading = $derived(appState.favorites.isLoading);

    function handleClose() {
        appState.favorites.deactivate();
        appState.ui.popView();
    }
</script>

<div class="favorites-view" use:swipeBack={{ onClose: handleClose, ui: appState.ui }}>
    <SearchBar favoritesMode />

    <div class="content-wrapper">
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
    </div>
</div>

<style>
.favorites-view {
    min-height: 100%;
}

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
</style>
