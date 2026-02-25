<script lang="ts">
    import { tick, getContext } from 'svelte';
    import { appState } from '$lib/state/index.svelte.js';
    import { swipeBack } from '$lib/actions/swipeBack.js';
    import { sentinel } from '$lib/actions/sentinel.js';
    import { ReaderMemoryManager } from '$lib/services/ReaderMemoryManager.js';
    import { observePageImages, disconnectPageObserver, flushPageObserver } from '$lib/actions/observePageImages.js';
    import { observeChapterBoundary, disconnectChapterObserver } from '$lib/actions/observeChapterBoundary.js';
    import { MAX_CHAPTER_DISTANCE } from '$lib/constants.js';
    import type { LoadedChapter } from '$lib/types.js';

    const getReaderRoot = getContext<() => HTMLElement | null>('readerRoot');

    let {
        chapters,
        onClose,
    }: {
        chapters: LoadedChapter[];
        onClose: () => void;
    } = $props();

    const memory = new ReaderMemoryManager();
    const { pageTracker } = appState.reader;

    // Session lifecycle
    let initialized = false;
    let sentinelsReady = $state(false);

    async function restoreScrollPosition() {
        await tick();
        const root = getReaderRoot();
        if (!root) {
            sentinelsReady = true;
            return;
        }

        const pageIndex = appState.reader.consumePageRestore();
        if (pageIndex != null && pageIndex > 0) {
            const pages = root.querySelectorAll('.reader-page');
            const target = pages[pageIndex];
            if (target) {
                target.scrollIntoView({ block: 'start' });
            } else {
                root.scrollTop = 0;
            }
        } else {
            root.scrollTop = 0;
        }

        requestAnimationFrame(() => {
            sentinelsReady = true;
        });
    }

    function handleScroll() {
        const root = getReaderRoot();
        if (!root) return;
        pageTracker.handleScroll(root, memory.pageDataMap, (chapterId, pageIndex) => {
            appState.reader.trackVisiblePage(chapterId, pageIndex);
        });
    }

    $effect(() => {
        const count = chapters.length;
        if (count === 0) {
            if (initialized) {
                memory.revokeAll();
                disconnectPageObserver();
                disconnectChapterObserver();
                appState.reader.clearHistorySync();
                pageTracker.clearScroll();
                sentinelsReady = false;
                initialized = false;

                // Remove scroll listener
                const root = getReaderRoot();
                if (root) root.removeEventListener('scroll', handleScroll);
            }
            return;
        }

        if (!initialized) {
            memory.root = getReaderRoot();
            memory.startSession();
            initialized = true;

            // Attach scroll listener
            const root = getReaderRoot();
            if (root) root.addEventListener('scroll', handleScroll, { passive: true });

            // Flush any page nodes queued before root was ready
            flushPageObserver(memory, getReaderRoot);

            restoreScrollPosition();
        }
        memory.ensureAbortController();
    });

    // Chapter change: memory management + state sync
    function handleChapterChange(chapterId: number) {
        if (chapterId === appState.reader.currentChapterId) return;
        const root = getReaderRoot();
        if (!root) return;
        const pages = root.querySelectorAll('.reader-page');
        memory.cleanupDistantChapters(chapterId, chapters, pages);
        const curIdx = chapters.findIndex(c => c.chapterId === chapterId);
        for (let i = Math.max(0, curIdx - MAX_CHAPTER_DISTANCE); i <= Math.min(chapters.length - 1, curIdx + MAX_CHAPTER_DISTANCE); i++) {
            memory.reloadChapterImages(chapters[i].chapterId, pages);
        }
        appState.reader.syncChapterProgress(chapterId);
    }

    let appendSentinelEl = $state<HTMLElement>();

    async function handleAppend() {
        const loaded = await appState.reader.appendNextChapter();
        if (!loaded) return;
        await tick();
        // Sentinel IO doesn't re-fire when the element stays in the zone.
        // One-shot observer rechecks: if still within 500% rootMargin, load more.
        const root = getReaderRoot();
        if (!root || !appendSentinelEl?.isConnected) return;
        const checker = new IntersectionObserver(
            (entries) => {
                checker.disconnect();
                if (entries[0]?.isIntersecting) handleAppend();
            },
            { rootMargin: '500% 0px', root },
        );
        checker.observe(appendSentinelEl);
    }

    async function handlePrepend() {
        const container = getReaderRoot();
        if (!container) return;

        const firstSep = container.querySelector('.chapter-separator');
        const anchorRect = firstSep?.getBoundingClientRect();

        const prepended = await appState.reader.prependPrevChapter();
        if (!prepended) return;

        await tick();

        if (firstSep && anchorRect) {
            const newRect = firstSep.getBoundingClientRect();
            const diff = newRect.top - anchorRect.top;
            if (Math.abs(diff) > 1) {
                container.scrollTop += diff;
            }
        }
    }
</script>

{#if chapters.length > 0}
    <div
        class="reader-wrapper"
        role="application"
        use:swipeBack={{ onClose, ui: appState.ui }}
    >
        <!-- Prepend sentinel at very top -->
        <div class="sentinel" use:sentinel={{ getRoot: getReaderRoot, rootMargin: '500% 0px', onIntersect: handlePrepend, disabled: !sentinelsReady }}></div>

        {#each chapters as chapter (chapter.chapterId)}
            <div
                class="chapter-separator"
                data-chapter-id={chapter.chapterId}
                use:observeChapterBoundary={{ getRoot: getReaderRoot, onChapterChange: handleChapterChange }}
            >
                Chapter {chapter.number} ({chapter.groupName})
            </div>
            {#each chapter.pages as page, i}
                {@const aspectRatio = page.width && page.height ? `${page.width}/${page.height}` : '2/3'}
                <div
                    class="reader-page"
                    use:observePageImages={() => ({ memory, getRoot: getReaderRoot, chapterId: chapter.chapterId, pageIndex: i, url: page.url })}
                    style="aspect-ratio:{aspectRatio}"
                >
                    <img alt="Ch.{chapter.number} P.{i + 1}" decoding="async" />
                </div>
            {/each}
        {/each}

        <!-- Append sentinel at very bottom -->
        <div class="sentinel" bind:this={appendSentinelEl} use:sentinel={{ getRoot: getReaderRoot, rootMargin: '500% 0px', onIntersect: handleAppend, disabled: !sentinelsReady }}></div>

        {#if appState.reader.isLoadingNext}
            <div class="empty" style="padding:20px">Loading next chapter...</div>
        {/if}
    </div>
{/if}

<style>
.chapter-separator {
    padding: 16px;
    text-align: center;
    color: #888;
    font-weight: bold;
    font-size: 14px;
    background: #111;
    border-top: 1px solid #333;
    border-bottom: 1px solid #333;
}

.reader-wrapper {
    background: #000;
    min-height: 100vh;
    user-select: none;
    -webkit-user-select: none;
    overflow-anchor: none;
}

.reader-page {
    width: 100%;
    display: block;
}

.reader-page img {
    width: 100%;
    display: block;
    -webkit-user-drag: none;
    pointer-events: none;
}
</style>
