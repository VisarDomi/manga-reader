<script lang="ts">
    import { onMount } from 'svelte';
    import { appState } from '$lib/state/index.svelte.js';
    import SearchBar from '$lib/components/SearchBar.svelte';
    import MangaList from '$lib/components/MangaList.svelte';

    const favsItems = $derived(appState.favorites.items);
    const favsLoading = $derived(appState.favorites.isLoading);
    let mountedAt = 0;
    let updateCount = 0;

    onMount(() => {
        mountedAt = performance.now();
        appState.log.emit('favorites-view-lifecycle', {
            phase: 'mount',
            items: favsItems.length,
            isLoading: favsLoading,
            updateCount,
            dtMs: 0,
        });
        return () => {
            appState.log.emit('favorites-view-lifecycle', {
                phase: 'unmount',
                items: favsItems.length,
                isLoading: favsLoading,
                updateCount,
                dtMs: Math.round(performance.now() - mountedAt),
            });
        };
    });

    $effect(() => {
        const items = favsItems.length;
        const isLoading = favsLoading;
        if (mountedAt === 0) return;
        updateCount++;
        appState.log.emit('favorites-view-lifecycle', {
            phase: 'update',
            items,
            isLoading,
            updateCount,
            dtMs: Math.round(performance.now() - mountedAt),
        });
    });
</script>

<div class="favorites-view">
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
            <MangaList manga={favsItems} trackVisible source="favorites" />
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
