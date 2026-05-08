<script lang="ts">
    import { onMount } from 'svelte';
    import { appState } from '$lib/state/index.svelte.js';
    import type { Manga } from '$lib/types.js';
    import MangaCoverCard from './MangaCoverCard.svelte';

    let { manga, trackVisible = false }: { manga: Manga[]; trackVisible?: boolean } = $props();

    let gridEl: HTMLElement | null = null;
    const mangaIds = $derived(manga.map(item => item.id).join('\0'));

    function scrollRoot(): HTMLElement | null {
        let el = gridEl?.parentElement ?? null;
        while (el) {
            const style = getComputedStyle(el);
            if (/(auto|scroll)/.test(`${style.overflowY}${style.overflow}`)) return el;
            el = el.parentElement;
        }
        return null;
    }

    function visibleManga(root: HTMLElement): Manga[] {
        if (!gridEl) return [];
        const byId = new Map(manga.map(item => [item.id, item]));
        const ids: string[] = [];
        const rootRect = root.getBoundingClientRect();
        const cards = gridEl.querySelectorAll('[data-manga-id]');
        for (const card of cards) {
            const rect = card.getBoundingClientRect();
            if (rect.bottom > rootRect.top && rect.top < rootRect.bottom) {
                const id = card.getAttribute('data-manga-id');
                if (id) ids.push(id);
            }
        }
        return ids.map(id => byId.get(id)).filter(item => item != null);
    }

    function trackCenteredManga() {
        if (!trackVisible) return;
        const centerY = window.innerHeight / 2;
        const centerX = window.innerWidth / 2;
        const el = document.elementFromPoint(centerX, centerY);
        const card = el?.closest('[data-manga-id]');
        const id = card?.getAttribute('data-manga-id');
        if (id) appState.trackVisibleManga(id);
    }

    function prewarmVisible() {
        if (!trackVisible) return;
        const root = scrollRoot();
        if (!root) return;
        const visible = visibleManga(root);
        if (visible.length > 0) appState.prewarmVisibleManga(visible);
    }

    $effect(() => {
        if (!trackVisible) return;
        mangaIds;
        requestAnimationFrame(() => prewarmVisible());
    });

    onMount(() => {
        const root = scrollRoot();
        if (!root) return;

        let ticking = false;
        function onScroll() {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(() => {
                ticking = false;
                trackCenteredManga();
                prewarmVisible();
            });
        }

        root.addEventListener('scroll', onScroll, { passive: true });
        requestAnimationFrame(() => prewarmVisible());

        return () => root.removeEventListener('scroll', onScroll);
    });
</script>

<div class="manga-grid" bind:this={gridEl}>
    {#each manga as m (m.id)}
        <MangaCoverCard manga={m} />
    {/each}
</div>

<style>
.manga-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0;
    padding: 0;
}

@media (min-width: 480px) {
    .manga-grid {
        grid-template-columns: repeat(4, 1fr);
    }
}

@media (min-width: 768px) {
    .manga-grid {
        grid-template-columns: repeat(5, 1fr);
    }
}
</style>
