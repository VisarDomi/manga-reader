<script lang="ts">
    import { appState } from '$lib/state/index.svelte.js';
    import { swipeBack } from '$lib/actions/swipeBack.js';
    import { TERMS } from '$lib/data/terms.js';
    import ChapterList from '$lib/components/ChapterList.svelte';

    const manga = $derived(appState.manga.activeManga);

    const TERM_MAP = new Map(TERMS.map(t => [t.id, t]));

    const tags = $derived.by(() => {
        if (!manga?.termIds) return [];
        return manga.termIds
            .map(id => TERM_MAP.get(id))
            .filter((t): t is NonNullable<typeof t> => t != null);
    });
    const chapters = $derived(appState.manga.chapters);
    const isLoading = $derived(appState.manga.isLoading);
    const isFav = $derived(manga ? appState.favorites.isFavorited(manga.slug) : false);

    // Reset scroll to top when a new manga opens (before chapters load)
    $effect(() => {
        if (isLoading) {
            const view = document.getElementById('view-manga');
            if (view) view.scrollTop = 0;
        }
    });

    function handleClose() {
        appState.manga.closeManga();
    }
</script>

{#if manga}
    <div class="manga-view" use:swipeBack={{ onClose: handleClose, ui: appState.ui }}>
        <div class="manga-view-header">
            <div class="manga-view-title-row">
                <h1>{manga.title}</h1>
                <button class="fav-btn" class:fav-active={isFav} onclick={() => manga && appState.favorites.toggle(manga)}>
                    {isFav ? '❤' : '♡'}
                </button>
            </div>
            {#if manga.author}
                <p class="manga-view-author">{manga.author}</p>
            {/if}
            {#if tags.length > 0}
                <div class="manga-tags">
                    {#each tags as tag (tag.id)}
                        <span class="manga-tag">{tag.name}</span>
                    {/each}
                </div>
            {/if}
        </div>

        {#if isLoading}
            <div class="empty">Loading chapters...</div>
        {:else if chapters.length === 0}
            <div class="empty">No chapters found</div>
        {:else}
            <ChapterList {chapters} />
        {/if}
    </div>
{/if}

<style>
.manga-view {
    padding: max(15px, env(safe-area-inset-top)) 0 0;
    min-height: 100%;
}

.manga-view-header {
    padding: 0 16px 12px;
    border-bottom: 1px solid #222;
}

.manga-view-title-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
}

.manga-view-header h1 {
    margin: 0;
    font-size: 1.3rem;
    line-height: 1.3;
    color: #fff;
    flex: 1;
}

.fav-btn {
    flex-shrink: 0;
    font-size: 1.5rem;
    line-height: 1;
    padding: 4px;
    color: #666;
    transition: color 0.15s;
}

.fav-btn.fav-active {
    color: #f87171;
}

.manga-view-author {
    margin: 4px 0 0;
    font-size: 14px;
    color: #888;
}

.manga-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-top: 8px;
}

.manga-tag {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 4px;
    background: #222;
    color: #aaa;
    border: 1px solid #333;
}
</style>
