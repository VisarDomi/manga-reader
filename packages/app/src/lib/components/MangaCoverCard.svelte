<script lang="ts">
    import { onMount } from 'svelte';
    import { appState } from '$lib/state/index.svelte.js';
    import MangaCoverImage from './MangaCoverImage.svelte';
    import { recordMangaCardPerf, type MangaListSource } from '$lib/services/PerfDiagnostics.js';
    import type { Manga } from '$lib/types.js';
    import type { ProgressData } from '$lib/state/progress.svelte.js';

    let { manga, source = 'search', onSelect }: { manga: Manga; source?: MangaListSource; onSelect?: (manga: Manga) => void } = $props();

    const latestChapter = $derived(manga.latestChapter ?? 0);
    let progress = $state<ProgressData | null>(null);
    let filteredMaxSnapshot = $state({ filteredMax: null as number | null });
    const readChapter = $derived(progress?.chapterNumber ?? 0);
    const filteredMax = $derived(filteredMaxSnapshot.filteredMax ?? latestChapter);
    const hasProgress = $derived(progress != null);

    function syncStats() {
        filteredMaxSnapshot = appState.chapterStats.snapshot(manga.id, manga.latestChapter ?? null);
    }

    onMount(() => {
        recordMangaCardPerf(appState.log.emit, source, 'mounted');
        const unsubscribeProgress = appState.progress.subscribe(manga.id, value => {
            recordMangaCardPerf(appState.log.emit, source, 'progressCallbacks');
            progress = value;
        });
        const unsubscribeStats = appState.chapterStats.subscribe(manga.id, () => {
            recordMangaCardPerf(appState.log.emit, source, 'statsCallbacks');
            syncStats();
        });
        return () => {
            unsubscribeProgress();
            unsubscribeStats();
            recordMangaCardPerf(appState.log.emit, source, 'unmounted');
        };
    });
</script>

<button class="manga-card" data-manga-id={manga.id} onclick={() => onSelect ? onSelect(manga) : appState.manga.openManga(manga)}>
    <div class="manga-card-cover">
        <MangaCoverImage mangaId={manga.id} title={manga.title} sourceUrl={manga.cover || undefined} variant="card" {source} />
    </div>
    <div class="manga-card-info">
        {#if manga.latestChapter != null}
            <div class="manga-card-chapters">
                <span class:started={hasProgress} class="read-chapter">{readChapter}</span>
                <span class="chapter-divider">/</span>
                <span class="filtered-chapter">{filteredMax}</span>
                <span class="chapter-divider">/</span>
                <span>{latestChapter}</span>
            </div>
        {/if}
    </div>
</button>

<style>
.manga-card {
    position: relative;
    aspect-ratio: 2/3;
    background: #222;
    overflow: hidden;
    cursor: pointer;
    text-align: left;
}

.manga-card:active {
    opacity: 0.8;
}

.manga-card-cover {
    position: absolute;
    inset: 0;
}

.manga-card-info {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 0 5px 4px;
}

.manga-card-chapters {
    font-size: 10px;
    font-weight: 700;
    background: rgba(10, 10, 10, 0.8);
    color: #fff;
    padding: 1px 4px;
    border-radius: 4px;
    display: inline-flex;
    gap: 3px;
    align-items: center;
}

.read-chapter {
    background: rgba(239, 68, 68, 0.9);
    color: #fff;
    border-radius: 3px;
    min-width: 14px;
    padding: 0 3px;
    text-align: center;
}

.read-chapter.started {
    background: rgba(74, 246, 38, 0.9);
    color: #000;
}

.filtered-chapter {
    border-radius: 3px;
    min-width: 14px;
    padding: 0 3px;
    text-align: center;
}

.chapter-divider {
    opacity: 0.5;
}
</style>
