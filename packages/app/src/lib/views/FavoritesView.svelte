<script lang="ts">
    import { onMount } from 'svelte';
    import { appState } from '$lib/state/index.svelte.js';
    import { swipeBack } from '$lib/actions/swipeBack.js';
    import SearchBar from '$lib/components/SearchBar.svelte';
    import MangaList from '$lib/components/MangaList.svelte';

    const favsItems = $derived(appState.favorites.items);
    const favsLoading = $derived(appState.favorites.isLoading);
    let listEl: HTMLElement | null = null;

    function handleClose() {
        appState.favorites.deactivate();
        appState.ui.popView();
    }

    function prewarmVisible() {
        if (!listEl) return;
        const byId = new Map(favsItems.map(manga => [manga.id, manga]));
        const ids: string[] = [];
        const cards = listEl.querySelectorAll('[data-manga-id]');
        const viewTop = listEl.scrollTop;
        const viewBottom = viewTop + listEl.clientHeight;
        for (const card of cards) {
            const el = card as HTMLElement;
            const top = el.offsetTop;
            const bottom = top + el.offsetHeight;
            if (bottom > viewTop && top < viewBottom) {
                const id = el.getAttribute('data-manga-id');
                if (id) ids.push(id);
            }
        }
        if (ids.length === 0) return;
        appState.prewarmVisibleManga(ids.map(id => byId.get(id)).filter(manga => manga != null));
    }

    $effect(() => {
        favsItems.length;
        requestAnimationFrame(() => prewarmVisible());
    });

    onMount(() => {
        listEl = document.getElementById('view-favorites');
        if (!listEl) return;

        let ticking = false;
        function onScroll() {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(() => {
                ticking = false;
                prewarmVisible();
            });
        }

        listEl.addEventListener('scroll', onScroll, { passive: true });
        requestAnimationFrame(() => prewarmVisible());

        return () => listEl.removeEventListener('scroll', onScroll);
    });
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
