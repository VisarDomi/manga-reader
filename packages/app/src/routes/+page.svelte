<script lang="ts">
    import { onMount, setContext } from 'svelte';
    import { appState } from '$lib/state/index.svelte.js';
    import { View } from '$lib/logic.js';
    import { initAppDimensions } from '$lib/state/appDimensions.js';
    import ListView from '$lib/views/ListView.svelte';
    import FavoritesView from '$lib/views/FavoritesView.svelte';
    import MangaView from '$lib/views/MangaView.svelte';
    import ReaderView from '$lib/views/ReaderView.svelte';
    import ChapterCommentsView from '$lib/views/ChapterCommentsView.svelte';
    import Toast from '$lib/components/Toast.svelte';

    let readerRoot = $state<HTMLElement | null>(null);
    setContext('readerRoot', () => readerRoot);

    onMount(() => {
        initAppDimensions();
        appState.init();
    });

    const viewMode = $derived(appState.ui.viewMode);
    const isSwiping = $derived(appState.ui.isSwiping);
    const swipeAnimating = $derived(appState.ui.swipeAnimating);
    const isForwardSwiping = $derived(appState.ui.isForwardSwiping);
    const forwardSwipeAnimating = $derived(appState.ui.forwardSwipeAnimating);

    const backView = $derived(isSwiping ? appState.ui.peekBack() : null);

    const inReader = $derived(viewMode === View.READER);
    const inChapterComments = $derived(viewMode === View.CHAPTER_COMMENTS);
    const showingChapterComments = $derived(inChapterComments || isForwardSwiping || forwardSwipeAnimating);
    const inManga = $derived(viewMode === View.MANGA);
    const isNestedMangaSwipe = $derived(inManga && backView === View.MANGA);
    const inFavorites = $derived(viewMode === View.FAVORITES);
</script>

<div
    id="view-list"
    class="view-layer"
    class:view-hidden={viewMode !== View.LIST && backView !== View.LIST}
    class:swipe-back={backView === View.LIST}
    class:swipe-animating={backView === View.LIST && swipeAnimating}
>
    <ListView />
</div>

<div
    id="view-favorites"
    class="view-layer"
    class:view-hidden={viewMode !== View.FAVORITES && backView !== View.FAVORITES}
    class:swipe-back={backView === View.FAVORITES}
    class:swipe-animating={backView === View.FAVORITES && swipeAnimating}
    class:swipe-active={inFavorites && isSwiping}
    style="{inFavorites && isSwiping ? 'transform:translateX(var(--swipe-progress, 0%))' : ''}"
>
    <FavoritesView />
</div>

<div
    id="view-manga"
    class="view-layer"
    class:view-hidden={viewMode !== View.MANGA && backView !== View.MANGA}
    class:swipe-back={backView === View.MANGA}
    class:swipe-animating={backView === View.MANGA && swipeAnimating}
    class:swipe-active={inManga && isSwiping && !isNestedMangaSwipe}
    style="{inManga && isSwiping && !isNestedMangaSwipe ? 'transform:translateX(var(--swipe-progress, 0%))' : ''}"
>
    <MangaView />
</div>

<div
    bind:this={readerRoot}
    id="view-reader"
    class="view-layer"
    class:view-hidden={!inReader && backView !== View.READER}
    class:swipe-back={backView === View.READER}
    class:swipe-active={inReader && isSwiping}
    class:swipe-animating={(inReader || backView === View.READER) && swipeAnimating}
    style="{inReader && isSwiping ? 'transform:translateX(var(--swipe-progress, 0%))' : ''}"
>
    <ReaderView />
</div>

<div
    id="view-chapter-comments"
    class="view-layer"
    class:view-hidden={!showingChapterComments}
    class:swipe-active={inChapterComments && isSwiping || isForwardSwiping || forwardSwipeAnimating}
    class:swipe-animating={inChapterComments && swipeAnimating || forwardSwipeAnimating}
    style="{isForwardSwiping || forwardSwipeAnimating ? 'transform:translateX(var(--forward-swipe-progress, 100%))' : inChapterComments && isSwiping ? 'transform:translateX(var(--swipe-progress, 0%))' : ''}"
>
    <ChapterCommentsView />
</div>

<Toast />

<style>
.view-layer {
    position: absolute;
    inset: 0;
    overflow-y: auto;
    overflow-x: hidden;
    width: 100%;
    max-width: 100%;
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
