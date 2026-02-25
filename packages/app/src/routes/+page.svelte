<script lang="ts">
    import { onMount, setContext } from 'svelte';
    import { appState } from '$lib/state/index.svelte.js';
    import ListView from '$lib/views/ListView.svelte';
    import MangaView from '$lib/views/MangaView.svelte';
    import ReaderView from '$lib/views/ReaderView.svelte';
    import Toast from '$lib/components/Toast.svelte';

    let readerRoot = $state<HTMLElement | null>(null);
    setContext('readerRoot', () => readerRoot);

    onMount(() => {
        appState.init();
    });

    const viewMode = $derived(appState.ui.viewMode);
    const prevMode = $derived(appState.ui.previousViewMode);
    const isSwiping = $derived(appState.ui.isSwiping);
    const swipeAnimating = $derived(appState.ui.swipeAnimating);
    const swipeProgress = $derived(appState.ui.swipeProgress);

    // Swipe-back targets: reader→manga, manga→list
    const inReader = $derived(viewMode === 'reader');
    const inManga = $derived(viewMode === 'manga');

    // Show manga behind reader during swipe
    const mangaIsBack = $derived(inReader && prevMode === 'manga' && isSwiping);
    // Show list behind manga during swipe
    const listIsBack = $derived(inManga && prevMode === 'list' && isSwiping);
    // Show list behind reader if reader was opened from list
    const listIsBackFromReader = $derived(inReader && prevMode === 'list' && isSwiping);
</script>

<div
    id="view-list"
    class="view-layer"
    class:view-hidden={viewMode !== 'list' && !listIsBack && !listIsBackFromReader}
    class:swipe-back={listIsBack || listIsBackFromReader}
    class:swipe-animating={(listIsBack || listIsBackFromReader) && swipeAnimating}
>
    <ListView />
</div>

<div
    id="view-manga"
    class="view-layer"
    class:view-hidden={viewMode !== 'manga' && !mangaIsBack}
    class:swipe-back={mangaIsBack}
    class:swipe-animating={mangaIsBack && swipeAnimating}
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
