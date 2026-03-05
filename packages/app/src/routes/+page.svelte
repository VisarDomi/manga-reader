<script lang="ts">
    import { onMount, setContext } from 'svelte';
    import { appState } from '$lib/state/index.svelte.js';
    import ListView from '$lib/views/ListView.svelte';
    import FavoritesView from '$lib/views/FavoritesView.svelte';
    import MangaView from '$lib/views/MangaView.svelte';
    import ReaderView from '$lib/views/ReaderView.svelte';
    import Toast from '$lib/components/Toast.svelte';

    let readerRoot = $state<HTMLElement | null>(null);
    setContext('readerRoot', () => readerRoot);

    onMount(() => {
        appState.init();
    });

    const viewMode = $derived(appState.ui.viewMode);
    const isSwiping = $derived(appState.ui.isSwiping);
    const swipeAnimating = $derived(appState.ui.swipeAnimating);
    const swipeProgress = $derived(appState.ui.swipeProgress);

    // The view that would be revealed behind the current view during swipe
    const backView = $derived(isSwiping ? appState.ui.peekBack() : null);

    const inReader = $derived(viewMode === 'reader');
    const inManga = $derived(viewMode === 'manga');
    const inFavorites = $derived(viewMode === 'favorites');
</script>

<div
    id="view-list"
    class="view-layer"
    class:view-hidden={viewMode !== 'list' && backView !== 'list'}
    class:swipe-back={backView === 'list'}
    class:swipe-animating={backView === 'list' && swipeAnimating}
>
    <ListView />
</div>

<div
    id="view-favorites"
    class="view-layer"
    class:view-hidden={viewMode !== 'favorites' && backView !== 'favorites'}
    class:swipe-back={backView === 'favorites'}
    class:swipe-animating={backView === 'favorites' && swipeAnimating}
    class:swipe-active={inFavorites && isSwiping}
    style="{inFavorites && isSwiping ? `transform:translateX(${swipeProgress * 100}%)` : ''}"
>
    <FavoritesView />
</div>

<div
    id="view-manga"
    class="view-layer"
    class:view-hidden={viewMode !== 'manga' && backView !== 'manga'}
    class:swipe-back={backView === 'manga'}
    class:swipe-animating={backView === 'manga' && swipeAnimating}
    class:swipe-active={inManga && isSwiping}
    style="{inManga && isSwiping ? `transform:translateX(${swipeProgress * 100}%)` : ''}"
>
    <MangaView />
</div>

<div
    bind:this={readerRoot}
    id="view-reader"
    class="view-layer"
    class:view-hidden={!inReader}
    class:swipe-active={inReader && isSwiping}
    class:swipe-animating={inReader && swipeAnimating}
    style="{inReader && isSwiping ? `transform:translateX(${swipeProgress * 100}%)` : ''}"
>
    <ReaderView />
</div>

<Toast />

<style>
.view-layer {
    position: absolute;
    inset: 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    background: #000;
}

.view-layer.view-hidden {
    visibility: hidden;
    pointer-events: none;
}

.view-layer.swipe-active {
    z-index: 4;
    box-shadow: -10px 0 30px rgba(0, 0, 0, 0.3);
}

.view-layer.swipe-back {
    visibility: visible;
    pointer-events: none;
}

.view-layer.swipe-animating {
    transition: transform 250ms ease-out, opacity 250ms ease-out;
}
</style>
