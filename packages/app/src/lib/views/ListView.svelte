<script lang="ts">
    import { onMount } from 'svelte';
    import { appState } from '$lib/state/index.svelte.js';
    import { searchErrorMessage } from '$lib/state/search.svelte.js';
    import * as api from '$lib/services/api.js';
    import { sentinel } from '$lib/actions/sentinel.js';
    import { SENTINEL_ROOT_MARGIN } from '$lib/constants.js';
    import SearchBar from '$lib/components/SearchBar.svelte';
    import MangaList from '$lib/components/MangaList.svelte';

    const results = $derived(appState.searchState.results);
    const total = $derived(results.length);
    const query = $derived(appState.searchState.currentQuery);
    const isLoading = $derived(appState.searchState.isLoading);
    const hasMore = $derived(appState.searchState.hasMore);
    const error = $derived(appState.searchState.error);

    const sentToPrewarm = new Set<string>();

    onMount(() => {
        const listEl = document.getElementById('view-list');
        if (!listEl) return;

        let ticking = false;

        function prewarmVisible() {
            const ids: string[] = [];
            const cards = listEl!.querySelectorAll('[data-manga-id]');
            const viewTop = listEl!.scrollTop;
            const viewBottom = viewTop + listEl!.clientHeight;
            for (const card of cards) {
                const el = card as HTMLElement;
                const top = el.offsetTop;
                const bottom = top + el.offsetHeight;
                if (bottom > viewTop && top < viewBottom) {
                    const id = el.getAttribute('data-manga-id');
                    if (id && !sentToPrewarm.has(id)) ids.push(id);
                }
            }
            if (ids.length > 0) {
                for (const id of ids) sentToPrewarm.add(id);
                api.prewarmChapters(ids);
            }
        }

        function onScroll() {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(() => {
                ticking = false;
                const centerY = window.innerHeight / 2;
                const centerX = window.innerWidth / 2;
                const el = document.elementFromPoint(centerX, centerY);
                if (!el) return;
                const card = el.closest('[data-manga-id]');
                if (card) {
                    const id = card.getAttribute('data-manga-id');
                    if (id) appState.trackVisibleManga(id);
                }
                prewarmVisible();
            });
        }

        listEl.addEventListener('scroll', onScroll, { passive: true });

        // Prewarm the initial visible manga on mount
        requestAnimationFrame(() => prewarmVisible());

        return () => listEl.removeEventListener('scroll', onScroll);
    });
</script>

<SearchBar />

<div class="content-wrapper">
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
    {/if}

    {#if isLoading}
        <div class="empty">Loading...</div>
    {:else if error}
        <div class="empty error">{searchErrorMessage(error)}</div>
    {:else if total === 0}
        <div class="empty">No results</div>
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

.error {
    color: #ff6b6b;
}
</style>
