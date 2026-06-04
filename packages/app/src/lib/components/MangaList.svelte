<script lang="ts">
    import { onMount } from 'svelte';
    import { appState } from '$lib/state/index.svelte.js';
    import * as api from '$lib/services/api.js';
    import type { MangaListSource } from '$lib/services/PerfDiagnostics.js';
    import type { Manga } from '$lib/types.js';
    import MangaCoverCard from './MangaCoverCard.svelte';

    let {
        manga,
        trackVisible = false,
        source = 'search',
        onSelect,
    }: {
        manga: Manga[];
        trackVisible?: boolean;
        source?: MangaListSource;
        onSelect?: (manga: Manga) => void;
    } = $props();

    let gridEl: HTMLElement | null = null;
    let mountedAt = 0;
    let updateCount = 0;

    function scrollRoot(): HTMLElement | null {
        let el = gridEl?.parentElement ?? null;
        while (el) {
            const style = getComputedStyle(el);
            if (/(auto|scroll)/.test(`${style.overflowY}${style.overflow}`)) return el;
            el = el.parentElement;
        }
        return null;
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

    $effect(() => {
        const total = manga.length;
        if (mountedAt > 0) {
            updateCount++;
            appState.log.emit('manga-list-lifecycle', {
                source,
                phase: 'update',
                total,
                trackVisible,
                updateCount,
                dtMs: Math.round(performance.now() - mountedAt),
            });
        }
    });

    onMount(() => {
        mountedAt = performance.now();
        const controller = new AbortController();
        appState.log.emit('manga-list-lifecycle', {
            source,
            phase: 'mount',
            total: manga.length,
            trackVisible,
            updateCount,
            dtMs: 0,
        });
        if (source === 'recommendations' && manga.length > 0) {
            void api.fetchMangaCardSnapshots(manga, controller.signal, false)
                .catch(error => {
                    if (!controller.signal.aborted) {
                        appState.log.emit('manga-card-snapshots-error', {
                            providerId: appState.providerId,
                            count: manga.length,
                            includeChapters: false,
                            dtMs: Math.round(performance.now() - mountedAt),
                            error: String((error as Error)?.message ?? error),
                        });
                    }
                });
        }
        const root = scrollRoot();
        if (!root) {
            return () => {
                controller.abort();
                appState.log.emit('manga-list-lifecycle', {
                    source,
                    phase: 'unmount',
                    total: manga.length,
                    trackVisible,
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
            });
        }

        root.addEventListener('scroll', onScroll, { passive: true });

        return () => {
            controller.abort();
            root.removeEventListener('scroll', onScroll);
            appState.log.emit('manga-list-lifecycle', {
                source,
                phase: 'unmount',
                total: manga.length,
                trackVisible,
                updateCount,
                dtMs: Math.round(performance.now() - mountedAt),
            });
        };
    });
</script>

<div class="manga-grid" bind:this={gridEl}>
    {#each manga as m (m.id)}
        <MangaCoverCard manga={m} source={source} {onSelect} />
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
