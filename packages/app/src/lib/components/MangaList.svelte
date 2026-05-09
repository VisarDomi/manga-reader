<script lang="ts">
    import { onMount } from 'svelte';
    import { appState } from '$lib/state/index.svelte.js';
    import type { MangaListSource } from '$lib/services/PerfDiagnostics.js';
    import type { Manga } from '$lib/types.js';
    import MangaCoverCard from './MangaCoverCard.svelte';

    let {
        manga,
        trackVisible = false,
        prewarmGeneration = 0,
        source = 'search',
    }: {
        manga: Manga[];
        trackVisible?: boolean;
        prewarmGeneration?: number;
        source?: MangaListSource;
    } = $props();

    let gridEl: HTMLElement | null = null;
    let lastPrewarmPerfLogAt = 0;
    let mountedAt = 0;
    let updateCount = 0;
    const mangaById = $derived.by(() => new Map(manga.map(item => [item.id, item])));

    type VisibleMangaResult = {
        items: Manga[];
        sampled: number;
        columns: number;
        firstRow: number;
        lastRow: number;
        rootHeight: number;
    };

    function scrollRoot(): HTMLElement | null {
        let el = gridEl?.parentElement ?? null;
        while (el) {
            const style = getComputedStyle(el);
            if (/(auto|scroll)/.test(`${style.overflowY}${style.overflow}`)) return el;
            el = el.parentElement;
        }
        return null;
    }

    function visibleManga(root: HTMLElement): VisibleMangaResult {
        const empty = {
            items: [],
            sampled: 0,
            columns: 0,
            firstRow: 0,
            lastRow: -1,
            rootHeight: root.clientHeight,
        };
        if (!gridEl) return empty;
        const rootRect = root.getBoundingClientRect();
        const gridRect = gridEl.getBoundingClientRect();
        const firstCard = gridEl.querySelector<HTMLElement>('[data-manga-id]');
        const cardRect = firstCard?.getBoundingClientRect();
        if (!cardRect || cardRect.width <= 0 || cardRect.height <= 0 || gridRect.width <= 0) return empty;

        const columns = Math.max(1, Math.round(gridRect.width / cardRect.width));
        const margin = rootRect.height / 2;
        const windowTop = rootRect.top - margin;
        const windowBottom = rootRect.bottom + margin;
        const startY = Math.max(0, windowTop - gridRect.top);
        const endY = Math.max(0, windowBottom - gridRect.top);
        const firstRow = Math.max(0, Math.floor(startY / cardRect.height));
        const lastRow = Math.min(
            Math.ceil(manga.length / columns) - 1,
            Math.floor(endY / cardRect.height),
        );
        const firstIndex = firstRow * columns;
        const lastIndex = Math.min(manga.length, (lastRow + 1) * columns);
        const items = manga.slice(firstIndex, lastIndex).map(item => mangaById.get(item.id) ?? item);
        return {
            items,
            sampled: Math.max(0, lastIndex - firstIndex),
            columns,
            firstRow,
            lastRow,
            rootHeight: rootRect.height,
        };
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

    function prewarmVisible(source: 'generation' | 'scroll' | 'mount') {
        if (!trackVisible) return;
        const root = scrollRoot();
        if (!root) return;
        const started = performance.now();
        const visible = visibleManga(root);
        const scanMs = performance.now() - started;
        if (visible.items.length > 0) appState.prewarmVisibleManga(visible.items);

        const now = performance.now();
        if (manga.length >= 500 && (scanMs >= 1 || now - lastPrewarmPerfLogAt > 1000)) {
            lastPrewarmPerfLogAt = now;
            appState.log.emit('manga-list-prewarm-perf', {
                source,
                total: manga.length,
                sampled: visible.sampled,
                visible: visible.items.length,
                columns: visible.columns,
                firstRow: visible.firstRow,
                lastRow: visible.lastRow,
                scanMs: Math.round(scanMs * 10) / 10,
                rootHeight: Math.round(visible.rootHeight),
            });
        }
    }

    $effect(() => {
        const total = manga.length;
        const generation = prewarmGeneration;
        if (mountedAt > 0) {
            updateCount++;
            appState.log.emit('manga-list-lifecycle', {
                source,
                phase: 'update',
                total,
                trackVisible,
                prewarmGeneration: generation,
                updateCount,
                dtMs: Math.round(performance.now() - mountedAt),
            });
        }
        if (!trackVisible) return;
        requestAnimationFrame(() => prewarmVisible('generation'));
    });

    onMount(() => {
        mountedAt = performance.now();
        appState.log.emit('manga-list-lifecycle', {
            source,
            phase: 'mount',
            total: manga.length,
            trackVisible,
            prewarmGeneration,
            updateCount,
            dtMs: 0,
        });
        const root = scrollRoot();
        if (!root) {
            return () => {
                appState.log.emit('manga-list-lifecycle', {
                    source,
                    phase: 'unmount',
                    total: manga.length,
                    trackVisible,
                    prewarmGeneration,
                    updateCount,
                    dtMs: Math.round(performance.now() - mountedAt),
                });
            };
        }

        let ticking = false;
        function onScroll() {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(() => {
                ticking = false;
                trackCenteredManga();
                prewarmVisible('scroll');
            });
        }

        root.addEventListener('scroll', onScroll, { passive: true });
        requestAnimationFrame(() => prewarmVisible('mount'));

        return () => {
            root.removeEventListener('scroll', onScroll);
            appState.log.emit('manga-list-lifecycle', {
                source,
                phase: 'unmount',
                total: manga.length,
                trackVisible,
                prewarmGeneration,
                updateCount,
                dtMs: Math.round(performance.now() - mountedAt),
            });
        };
    });
</script>

<div class="manga-grid" bind:this={gridEl}>
    {#each manga as m (m.id)}
        <MangaCoverCard manga={m} source={source} />
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
