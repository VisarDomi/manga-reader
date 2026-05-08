<script lang="ts">
    import { tick, getContext } from 'svelte';
    import { appState } from '$lib/state/index.svelte.js';
    import { loadErrorMessage } from '$lib/state/errors.js';
    import { swipeBack } from '$lib/actions/swipeBack.js';
    import { swipeForward } from '$lib/actions/swipeForward.js';
    import { ReaderMemoryManager } from '$lib/services/ReaderMemoryManager.js';
    import { registerPageImage } from '$lib/actions/observePageImages.js';
    import { ReaderScrollCoordinator } from '$lib/services/ReaderScrollCoordinator.js';
    import {
        READER_CHAPTER_SEPARATOR_HEIGHT,
        READER_FALLBACK_PAGE_ASPECT_RATIO,
    } from '$lib/constants.js';
    import type { LoadedChapter } from '$lib/types.js';

    const getReaderRoot = getContext<() => HTMLElement | null>('readerRoot');

    let {
        chapters,
        onClose,
    }: {
        chapters: LoadedChapter[];
        onClose: () => void;
    } = $props();

    const memory = new ReaderMemoryManager(appState.log.emit);
    const scrollCoordinator = new ReaderScrollCoordinator();
    const { pageTracker } = appState.reader;
    const mangaTitle = $derived(appState.manga.activeManga?.title ?? 'Unknown Manga');
    const virtualHeight = $derived(Math.max(appState.reader.virtualTotalHeight, chapters.reduce((sum, chapter) => sum + (chapter.virtualHeight ?? chapter.estimatedHeight ?? 0), 0)));

    let failureTimestamps: number[] = [];
    let slowToastShown = false;

    memory.onLoadFailure = () => {
        if (slowToastShown) return;
        const now = Date.now();
        failureTimestamps.push(now);
        failureTimestamps = failureTimestamps.filter(t => now - t < 10_000);
        if (failureTimestamps.length >= 3) {
            slowToastShown = true;
            appState.toast.show('Slow connection — images may not load');
        }
    };

    let initialized = false;
    let windowRaf: number | null = null;

    function reconcileReaderWindow(source: 'initial' | 'scroll' | 'visible' | 'retry', scrollTopOverride?: number) {
        const root = getReaderRoot();
        if (!root) return;
        appState.reader.recordChapterMeasurements(measureChapterHeights(root));
        appState.reader.reconcileReaderWindow({
            scrollTop: scrollTopOverride ?? root.scrollTop,
            clientHeight: root.clientHeight,
            clientWidth: root.clientWidth,
        }, source);
        scheduleVirtualImages(root);
    }

    function scheduleVirtualImages(root = getReaderRoot()) {
        if (!root) return;
        memory.loadVirtualWindow(chapters, root.scrollTop, root.clientHeight, root.clientWidth);
    }

    function queueWindowReconcile(source: 'scroll' | 'visible' | 'retry' = 'scroll') {
        if (windowRaf != null) return;
        windowRaf = requestAnimationFrame(() => {
            windowRaf = null;
            reconcileReaderWindow(source);
        });
    }

    function measureChapterHeights(root: HTMLElement): Array<{ chapterId: string; height: number }> {
        const rootRect = root.getBoundingClientRect();
        const sections = root.querySelectorAll<HTMLElement>('.reader-chapter');
        const measurements: Array<{ chapterId: string; height: number }> = [];
        for (const section of sections) {
            const chapterId = section.dataset.chapterId;
            if (!chapterId) continue;
            const rect = section.getBoundingClientRect();
            if (rect.bottom < rootRect.top || rect.top > rootRect.bottom) continue;
            measurements.push({ chapterId, height: rect.height });
        }
        return measurements;
    }

    function scrollToCurrentChapterAnchor(root: HTMLElement) {
        const currentId = appState.reader.layoutChapterId;
        if (!currentId || appState.reader.pageRestoreTarget) return;
        const from = root.scrollTop;
        const target = appState.reader.chapterScrollTop(currentId, root.clientWidth) ?? 0;
        root.scrollTop = target;
        if (Math.abs(root.scrollTop - from) > 1) {
            appState.log.emit('reader-scroll-write', {
                source: 'initial-current-anchor',
                from: Math.round(from),
                to: Math.round(root.scrollTop),
                delta: Math.round(root.scrollTop - from),
            });
        }
    }

    function restoredPageScrollTop(root: HTMLElement, target: { pageIndex: number; scrollOffset: number }): number | null {
        const currentId = appState.reader.layoutChapterId;
        const chapter = chapters.find(ch => ch.id === currentId);
        if (!chapter || target.pageIndex < 0 || target.pageIndex >= chapter.pages.length) return null;

        let top = appState.reader.chapterScrollTop(currentId, root.clientWidth) ?? chapter.virtualTop ?? 0;
        top += READER_CHAPTER_SEPARATOR_HEIGHT;
        for (let i = 0; i < target.pageIndex; i++) {
            const page = chapter.pages[i];
            top += page.width && page.height
                ? root.clientWidth * page.height / page.width
                : root.clientWidth * READER_FALLBACK_PAGE_ASPECT_RATIO;
        }
        return top + target.scrollOffset;
    }

    async function restoreScrollPosition() {
        const root = getReaderRoot();
        if (!root) {
            return;
        }

        scrollCoordinator.beginInitialPosition(root);

        const restore = appState.reader.pageRestoreTarget;
        if (!restore) {
            const from = root.scrollTop;
            const currentId = appState.reader.layoutChapterId;
            const target = currentId ? appState.reader.chapterScrollTop(currentId, root.clientWidth) ?? 0 : 0;
            reconcileReaderWindow('initial', target);
            await tick();
            scrollToCurrentChapterAnchor(root);
            scrollCoordinator.cancelInitialPosition();
            appState.log.emit('reader-restore-scroll', {
                action: 'reset',
                target: 'top',
                from: Math.round(from),
                to: Math.round(root.scrollTop),
            });
            requestAnimationFrame(() => {
                appState.reader.clearPageRestore();
            });
            return;
        }

        const from = root.scrollTop;
        const restoreTop = restoredPageScrollTop(root, restore);
        scrollCoordinator.cancelInitialPosition();
        if (restoreTop == null) {
            const currentId = appState.reader.layoutChapterId;
            const target = currentId ? appState.reader.chapterScrollTop(currentId, root.clientWidth) ?? 0 : 0;
            reconcileReaderWindow('initial', target);
            await tick();
            scrollToCurrentChapterAnchor(root);
            appState.log.emit('reader-restore-scroll', {
                action: 'fallback',
                reason: 'missing-page',
                target: 'page',
                pageIndex: restore.pageIndex,
                from: Math.round(from),
                to: Math.round(root.scrollTop),
            });
            return;
        }

        reconcileReaderWindow('initial', restoreTop);
        await tick();
        root.scrollTop = restoreTop;
        if (Math.abs(root.scrollTop - from) > 1) {
            appState.log.emit('reader-scroll-write', {
                source: 'initial-restore-into-view',
                from: Math.round(from),
                to: Math.round(root.scrollTop),
                delta: Math.round(root.scrollTop - from),
            });
        }
        appState.log.emit('reader-restore-scroll', {
            action: 'restored',
            target: 'page',
            pageIndex: restore.pageIndex,
            scrollOffset: restore.scrollOffset,
            from: Math.round(from),
            to: Math.round(root.scrollTop),
        });

        requestAnimationFrame(() => {
            appState.reader.clearPageRestore();
        });
    }

    function handleScroll() {
        const root = getReaderRoot();
        if (!root) return;
        scrollCoordinator.noteUserScroll(root);
        queueWindowReconcile('scroll');
        pageTracker.handleScroll(root, memory.pageDataMap, (visible) => {
            appState.reader.trackVisiblePage(visible.chapterId, visible.pageIndex, visible.scrollOffset, 'scroll', visible);
        });
    }

    function handleClose() {
        const root = getReaderRoot();
        const visible = root ? pageTracker.findVisible(root, memory.pageDataMap) : null;
        appState.reader.logCloseSnapshot(visible);
        if (visible) appState.reader.trackVisiblePage(visible.chapterId, visible.pageIndex, visible.scrollOffset, 'close', visible);
        onClose();
    }

    $effect(() => {
        const count = chapters.length;
        if (count === 0) {
            if (initialized) {
                memory.revokeAll();
                appState.reader.clearHistorySync();
                pageTracker.clearScroll();
                initialized = false;
                failureTimestamps = [];
                slowToastShown = false;
                scrollCoordinator.cancelInitialPosition();
                scrollCoordinator.cancelPrepend();
                if (windowRaf != null) {
                    cancelAnimationFrame(windowRaf);
                    windowRaf = null;
                }

                const root = getReaderRoot();
                if (root) root.removeEventListener('scroll', handleScroll);
            }
            return;
        }

        if (!initialized) {
            memory.root = getReaderRoot();
            memory.startSession();
            initialized = true;

            const root = getReaderRoot();
            if (root) root.addEventListener('scroll', handleScroll, { passive: true });

            restoreScrollPosition();
        }
        memory.ensureAbortController();
        tick().then(() => scheduleVirtualImages());
    });

    function handleNextRetryClick() {
        if (appState.reader.isLoadingNext) {
            appState.reader.retryNextChapterNow();
            return;
        }
        appState.reader.retryNextChapterNow();
        queueWindowReconcile('retry');
    }
</script>

{#if chapters.length > 0}
    <div
        class="reader-wrapper"
        role="application"
        use:swipeBack={{ onClose: handleClose, ui: appState.ui }}
        use:swipeForward={{
            onPrepare: () => appState.reader.prepareChapterComments(),
            onCommit: () => appState.reader.commitPreparedChapterComments(),
            onCancel: () => appState.reader.cancelPreparedChapterComments(),
            ui: appState.ui,
        }}
    >
        <div class="reader-virtual-stage" style="height:{virtualHeight}px">
            {#each chapters as chapter (chapter.id)}
                {@const chapterTop = chapter.virtualTop ?? 0}
                {@const chapterHeight = Math.max(240, chapter.virtualHeight ?? chapter.estimatedHeight ?? 0)}
                <section
                    class="reader-chapter"
                    data-chapter-id={chapter.id}
                    style="height:{chapterHeight}px; transform:translateY({chapterTop}px)"
                >
                    <div
                        class="chapter-separator"
                        data-chapter-id={chapter.id}
                    >
                        Chapter {chapter.number} - {chapter.groupName} - {mangaTitle}
                    </div>
                    {#if chapter.slotState === 'ready' || chapter.pages.length > 0}
                        {#each chapter.pages as page, i}
                            {@const aspectRatio = page.width && page.height ? `${page.width}/${page.height}` : '2/3'}
                            <div
                                class="reader-page"
                                use:registerPageImage={() => ({ memory, chapterId: chapter.id, pageIndex: i, url: page.url })}
                                style="aspect-ratio:{aspectRatio}"
                            >
                                <img alt="Ch.{chapter.number} P.{i + 1}" decoding="async" />
                            </div>
                        {/each}
                    {:else}
                        <div class="chapter-placeholder" style="height:{chapterHeight}px">
                            Loading chapter {chapter.number}...
                        </div>
                    {/if}
                </section>
            {/each}
        </div>

        {#if appState.reader.nextChapterRetryAvailable}
            <div class="next-retry">
                <button type="button" onclick={handleNextRetryClick}>Load next chapter</button>
            </div>
        {:else if appState.reader.isLoadingNext}
            <div class="empty" style="padding:20px">Loading next chapter...</div>
        {/if}
    </div>
{:else}
    <div class="empty" style="padding:20px; color: {appState.reader.error ? '#ff6b6b' : '#888'}">
        {appState.reader.error ? loadErrorMessage(appState.reader.error) : 'Loading...'}
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

.reader-virtual-stage {
    position: relative;
    width: 100%;
    min-height: 100vh;
    overflow: hidden;
}

.reader-chapter {
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
    overflow: visible;
    contain: layout style;
}

.reader-page {
    width: 100%;
    display: block;
}

.chapter-placeholder {
    width: 100%;
    display: grid;
    place-items: center;
    color: #777;
    background: #050505;
    font-size: 14px;
}

.reader-page img {
    width: 100%;
    display: block;
    -webkit-user-drag: none;
    pointer-events: none;
}

.next-retry {
    display: flex;
    justify-content: center;
    padding: 24px 16px 32px;
}

.next-retry button {
    min-height: 44px;
    padding: 0 18px;
    border: 1px solid #444;
    border-radius: 6px;
    background: #181818;
    color: #f3f3f3;
    font: inherit;
    font-weight: 700;
}
</style>
