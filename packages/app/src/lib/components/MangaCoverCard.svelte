<script lang="ts">
    import { appState } from '$lib/state/index.svelte.js';
    import * as api from '$lib/services/api.js';
    import type { Manga } from '$lib/types.js';

    let { manga }: { manga: Manga } = $props();

    const coverUrl = $derived(manga.cover ? api.imageProxyUrl(manga.cover) : '');
    const progress = $derived(appState.progress.get(manga.id));
    const hasProgress = $derived(progress != null && manga.latestChapter != null);
</script>

<button class="manga-card" onclick={() => appState.manga.openManga(manga)}>
    <div class="manga-card-cover">
        {#if coverUrl}
            <img src={coverUrl} alt={manga.title} loading="lazy" decoding="async" />
        {/if}
    </div>
    <div class="manga-card-info">
        {#if hasProgress}
            <div class="manga-card-chapters">
                <span>{progress!.chapterNumber}</span>
                <span class="chapter-divider">/</span>
                <span>{manga.latestChapter}</span>
            </div>
        {:else if manga.latestChapter != null}
            <div class="manga-card-chapters no-progress">
                <span>Ch. {manga.latestChapter}</span>
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

.manga-card-cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
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
    background: rgba(74, 246, 38, 0.9);
    color: #000;
    padding: 1px 6px;
    border-radius: 4px;
    display: inline-flex;
    gap: 4px;
}

.manga-card-chapters.no-progress {
    background: none;
    color: #fff;
    padding: 0;
    text-shadow: 1px 1px 0 rgba(0, 0, 0, 0.3);
}

.chapter-divider {
    opacity: 0.5;
}
</style>
