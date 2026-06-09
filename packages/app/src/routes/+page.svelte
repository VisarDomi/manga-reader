<script lang="ts">
    import { onDestroy, onMount, setContext } from 'svelte';
    import { appState } from '$lib/state/index.svelte.js';
    import { View } from '$lib/logic.js';
    import { initAppDimensions } from '$lib/state/appDimensions.js';
    import ListView from '$lib/views/ListView.svelte';
    import FavoritesView from '$lib/views/FavoritesView.svelte';
    import ProvidersView from '$lib/views/ProvidersView.svelte';
    import MangaView from '$lib/views/MangaView.svelte';
    import ReaderView from '$lib/views/ReaderView.svelte';
    import ChapterCommentsView from '$lib/views/ChapterCommentsView.svelte';
    import Toast from '$lib/components/Toast.svelte';
    import { swipeBack } from '$lib/actions/swipeBack.js';
    import type { ViewMode } from '$lib/types.js';

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
    const inProviders = $derived(viewMode === View.PROVIDERS);
    const mountList = $derived(appState.ui.isMounted(View.LIST, backView));
    const mountFavorites = $derived(appState.ui.isMounted(View.FAVORITES, backView));
    const mountProviders = $derived(appState.ui.isMounted(View.PROVIDERS, backView));
    const mountManga = $derived(appState.ui.isMounted(View.MANGA, backView));
    const mountReader = $derived(appState.ui.isMounted(View.READER, backView));
    const mountChapterComments = $derived(appState.ui.isMounted(View.CHAPTER_COMMENTS, backView));
    const mountChapterCommentsSurface = $derived(inReader || showingChapterComments || mountChapterComments);
    const documentScrollViews = new Set<ViewMode>([View.LIST, View.FAVORITES, View.PROVIDERS, View.MANGA, View.CHAPTER_COMMENTS, View.READER]);
    const documentScrollPositions = new Map<ViewMode, number>();
    let activeDocumentScrollView: ViewMode | null = null;
    let restoreDocumentScrollRaf: number | null = null;
    const useDocumentScroll = $derived(
        !isSwiping
        && !swipeAnimating
        && !isForwardSwiping
        && !forwardSwipeAnimating
        && (viewMode === View.LIST || viewMode === View.FAVORITES || viewMode === View.PROVIDERS || viewMode === View.MANGA || viewMode === View.CHAPTER_COMMENTS || viewMode === View.READER)
    );

    function documentScrollTop(): number {
        if (typeof window === 'undefined') return 0;
        return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    }

    function viewElement(mode: ViewMode): HTMLElement | null {
        if (typeof document === 'undefined') return null;
        switch (mode) {
            case View.LIST:
                return document.getElementById('view-list');
            case View.FAVORITES:
                return document.getElementById('view-favorites');
            case View.PROVIDERS:
                return document.getElementById('view-providers');
            case View.MANGA:
                return document.getElementById('view-manga');
            case View.CHAPTER_COMMENTS:
                return document.getElementById('view-chapter-comments');
            case View.READER:
                return document.getElementById('view-reader');
            default:
                return null;
        }
    }

    function rememberDocumentScroll(mode: ViewMode | null) {
        if (!mode || !documentScrollViews.has(mode)) return;
        const scrollTop = documentScrollTop();
        documentScrollPositions.set(mode, scrollTop);
    }

    function restoreDocumentScroll(mode: ViewMode | null) {
        if (!mode || !documentScrollViews.has(mode)) return;
        if (restoreDocumentScrollRaf != null) cancelAnimationFrame(restoreDocumentScrollRaf);
        restoreDocumentScrollRaf = requestAnimationFrame(() => {
            restoreDocumentScrollRaf = null;
            const el = viewElement(mode);
            const target = documentScrollPositions.get(mode) ?? el?.scrollTop ?? 0;
            window.scrollTo(0, Math.max(0, target));
        });
    }

    $effect.pre(() => {
        if (typeof document === 'undefined') return;
        const nextDocumentScrollView = useDocumentScroll ? viewMode : null;
        if (activeDocumentScrollView !== nextDocumentScrollView) {
            rememberDocumentScroll(activeDocumentScrollView);
            activeDocumentScrollView = nextDocumentScrollView;
        }
    });

    $effect(() => {
        if (typeof document === 'undefined') return;
        const nextDocumentScrollView = useDocumentScroll ? viewMode : null;
        document.documentElement.classList.toggle('document-scroll-root', useDocumentScroll);
        document.body.classList.toggle('document-scroll-root', useDocumentScroll);
        if (nextDocumentScrollView) {
            restoreDocumentScroll(nextDocumentScrollView);
        } else {
            for (const mode of documentScrollViews) {
                const el = viewElement(mode);
                const pos = documentScrollPositions.get(mode);
                if (el && pos != null && !el.classList.contains('document-scroll')) {
                    el.scrollTop = pos;
                }
            }
        }
    });

    onDestroy(() => {
        if (restoreDocumentScrollRaf != null) cancelAnimationFrame(restoreDocumentScrollRaf);
        document.documentElement.classList.remove('document-scroll-root');
        document.body.classList.remove('document-scroll-root');
    });
</script>

<div
    id="view-list"
    class="view-layer"
    class:document-scroll={viewMode === View.LIST && useDocumentScroll}
    class:view-hidden={viewMode !== View.LIST && backView !== View.LIST}
    class:swipe-back={backView === View.LIST}
    class:swipe-animating={backView === View.LIST && swipeAnimating}
>
    {#if mountList}
        <ListView />
    {/if}
</div>

<div
    id="view-favorites"
    class="view-layer"
    class:document-scroll={viewMode === View.FAVORITES && useDocumentScroll}
    class:view-hidden={viewMode !== View.FAVORITES && backView !== View.FAVORITES}
    class:swipe-back={backView === View.FAVORITES}
    class:swipe-animating={backView === View.FAVORITES && swipeAnimating}
    class:swipe-active={inFavorites && isSwiping}
    style="{inFavorites && isSwiping ? 'transform:translateX(var(--swipe-progress, 0%))' : ''}"
>
    {#if mountFavorites}
        <FavoritesView />
    {/if}
</div>

<div
    id="view-providers"
    class="view-layer"
    class:document-scroll={viewMode === View.PROVIDERS && useDocumentScroll}
    class:view-hidden={viewMode !== View.PROVIDERS && backView !== View.PROVIDERS}
    class:swipe-back={backView === View.PROVIDERS}
    class:swipe-animating={backView === View.PROVIDERS && swipeAnimating}
    class:swipe-active={inProviders && isSwiping}
    style="{inProviders && isSwiping ? 'transform:translateX(var(--swipe-progress, 0%))' : ''}"
>
    {#if mountProviders}
        <ProvidersView />
    {/if}
</div>

<div
    id="view-manga"
    class="view-layer"
    class:document-scroll={viewMode === View.MANGA && useDocumentScroll}
    class:view-hidden={viewMode !== View.MANGA && backView !== View.MANGA}
    class:swipe-back={backView === View.MANGA}
    class:swipe-animating={backView === View.MANGA && swipeAnimating}
    class:swipe-active={inManga && isSwiping && !isNestedMangaSwipe}
    style="{inManga && isSwiping && !isNestedMangaSwipe ? 'transform:translateX(var(--swipe-progress, 0%))' : ''}"
>
    {#if mountManga}
        <MangaView />
    {/if}
</div>

<div
    bind:this={readerRoot}
    id="view-reader"
    class="view-layer"
    class:document-scroll={viewMode === View.READER && useDocumentScroll}
    class:view-hidden={!inReader && backView !== View.READER}
    class:swipe-back={backView === View.READER}
    class:swipe-active={inReader && isSwiping}
    class:swipe-animating={(inReader || backView === View.READER) && swipeAnimating}
    style="{inReader && isSwiping ? 'transform:translateX(var(--swipe-progress, 0%))' : ''}"
>
    {#if mountReader}
        <ReaderView />
    {/if}
</div>

<div
    id="view-chapter-comments"
    class="view-layer"
    class:document-scroll={viewMode === View.CHAPTER_COMMENTS && useDocumentScroll}
    class:view-hidden={!showingChapterComments}
    class:swipe-active={inChapterComments && isSwiping || isForwardSwiping || forwardSwipeAnimating}
    class:swipe-animating={inChapterComments && swipeAnimating || forwardSwipeAnimating}
    style="{isForwardSwiping || forwardSwipeAnimating ? 'transform:translateX(var(--forward-swipe-progress, 100%))' : inChapterComments && isSwiping ? 'transform:translateX(var(--swipe-progress, 0%))' : ''}"
    use:swipeBack={{ onClose: () => appState.reader.closeChapterComments(), ui: appState.ui }}
>
    {#if mountChapterCommentsSurface}
        <ChapterCommentsView />
    {/if}
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

.view-layer.document-scroll {
    position: relative;
    inset: auto;
    min-height: 100dvh;
    overflow: visible;
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
