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
    let windowReconcileTimer: ReturnType<typeof setTimeout> | null = null;
    let idleLayoutTimer: ReturnType<typeof setTimeout> | null = null;
    let idleLayoutSequence = 0;
    let idleLayoutQueuedAt = 0;
    let idleLayoutLastResetAt = 0;
    let idleLayoutResetCount = 0;
    let idleLayoutSource: 'scroll' | 'layout' = 'layout';
    let lastVisualSnapshotAt = 0;
    let lastSurfaceSnapshotAt = 0;
    let lastScrollPerfAt = 0;
    let lastScrollAt = 0;
    let lastScrollTop = 0;
    let scrollIdleTimer: ReturnType<typeof setTimeout> | null = null;
    let scrollSettledTimer: ReturnType<typeof setTimeout> | null = null;
    let scrollSettledGeneration = 0;
    let scrollSettledQueuedAt = 0;
    let scrollSettledLastTop = 0;
    let scrollSettledStableSamples = 0;
    let lastReconcileScrollTop = Number.NaN;
    let lastReconcileClientHeight = 0;
    let domProjectionEpoch = 0;
    let lastPageTrackAt = 0;
    let frameRaf: number | null = null;
    let lastFrameAt = 0;
    const IDLE_LAYOUT_DELAY_MS = 450;
    const SCROLL_IDLE_DELAY_MS = 180;
    const SCROLL_SETTLED_SAMPLE_MS = 120;
    const SCROLL_SETTLED_REQUIRED_SAMPLES = 3;
    const SCROLL_SETTLED_EPSILON_PX = 1;
    const SCROLL_RECONCILE_STEP_VIEWPORTS = 0.75;
    const PAGE_TRACK_INTERVAL_MS = 250;
    const READER_DIAGNOSTICS = {
        frameGapProbe: true,
        visualSnapshot: true,
    } as const;

    type VisualAnchor = {
        key: string;
        top: number;
        selection: 'owner' | 'probe';
        ownerChapterId: string | null;
    };

    function reconcileReaderWindow(
        source: 'initial' | 'scroll' | 'visible' | 'retry',
        scrollTopOverride?: number,
        queuedAt?: number,
        physicalWindowStartOverride?: number,
        projectionEpoch = physicalWindowStartOverride == null ? domProjectionEpoch : appState.reader.projectionEpoch,
    ) {
        const startedAt = performance.now();
        const root = getReaderRoot();
        if (!root) return;
        const measureStart = performance.now();
        if (source !== 'scroll') {
            appState.reader.recordChapterMeasurements(measureChapterHeights(root));
        }
        const measureMs = performance.now() - measureStart;
        if (appState.reader.pendingLayoutMeasurementCount > 0) {
            queueIdleLayoutPromotion('layout');
        }
        const scrollTop = scrollTopOverride ?? root.scrollTop;
        if (source === 'scroll') {
            lastReconcileScrollTop = scrollTop;
            lastReconcileClientHeight = root.clientHeight;
        }
        const stateStart = performance.now();
        const reconcile = appState.reader.reconcileReaderWindow({
            scrollTop,
            clientHeight: root.clientHeight,
            clientWidth: root.clientWidth,
            physicalWindowStart: physicalWindowStartOverride,
            projectionEpoch,
        }, source);
        const stateMs = performance.now() - stateStart;
        tick().then(() => {
            const tickStart = performance.now();
            if (reconcile && appState.reader.windowFrameEpoch === reconcile.frameEpoch && Math.abs(root.scrollTop - reconcile.physicalScrollTop) > 1) {
                const from = root.scrollTop;
                root.scrollTop = reconcile.physicalScrollTop;
                domProjectionEpoch = reconcile.projectionEpoch;
                lastReconcileScrollTop = root.scrollTop;
                lastReconcileClientHeight = root.clientHeight;
                appState.log.emit('reader-scroll-write', {
                    source: 'physical-rebase',
                    frameEpoch: reconcile.frameEpoch,
                    projectionEpoch: reconcile.projectionEpoch,
                    from: Math.round(from),
                    to: Math.round(root.scrollTop),
                    delta: Math.round(root.scrollTop - from),
                });
            } else if (reconcile) {
                domProjectionEpoch = reconcile.projectionEpoch;
            }
            const imagePerf = scheduleVirtualImages(root);
            const imagesMs = imagePerf?.totalMs ?? performance.now() - tickStart;
            logReaderSurfaceSnapshot('after-images', root);
            const totalMs = performance.now() - startedAt;
            const queuedForMs = queuedAt == null ? 0 : startedAt - queuedAt;
            if (totalMs < 8 && queuedForMs < 24 && source === 'scroll') return;
            appState.log.emit('reader-reconcile-perf', {
                source,
                queuedForMs: Math.round(queuedForMs),
                totalMs: Math.round(totalMs),
                measureMs: Math.round(measureMs),
                stateMs: Math.round(stateMs),
                tickMs: Math.round(tickStart - startedAt),
                imagesMs: Math.round(imagesMs),
                scrollTop: Math.round(root.scrollTop),
                pendingMeasurements: appState.reader.pendingLayoutMeasurementCount,
            });
        });
    }

    function scheduleVirtualImages(root = getReaderRoot()) {
        if (!root) return null;
        const perf = memory.loadVirtualWindow(
            chapters,
            root.scrollTop,
            root.clientHeight,
            root.clientWidth,
            appState.reader.pageGeometry(root.clientWidth),
            { allowCleanup: !appState.reader.isScrollActive },
        );
        return perf;
    }

    function logVisualSnapshot(root: HTMLElement, source: 'initial' | 'scroll' | 'images' | 'close', force = false) {
        if (!READER_DIAGNOSTICS.visualSnapshot) return;
        const now = performance.now();
        if (!force && now - lastVisualSnapshotAt < 750) return;
        lastVisualSnapshotAt = now;

        const rootRect = root.getBoundingClientRect();
        const sectionParts: string[] = [];
        for (const section of root.querySelectorAll<HTMLElement>('.reader-chapter')) {
            const rect = section.getBoundingClientRect();
            if (rect.bottom < rootRect.top || rect.top > rootRect.bottom) continue;
            const chapterId = section.dataset.chapterId ?? '';
            sectionParts.push(`${chapterId}:top=${Math.round(rect.top - rootRect.top)},bottom=${Math.round(rect.bottom - rootRect.top)},h=${Math.round(rect.height)}`);
        }

        let visiblePageCount = 0;
        let visibleImageCount = 0;
        let loadedImageCount = 0;
        let emptyImageCount = 0;
        const pageParts: string[] = [];
        for (const page of root.querySelectorAll<HTMLElement>('.reader-page')) {
            const rect = page.getBoundingClientRect();
            if (rect.bottom < rootRect.top || rect.top > rootRect.bottom) continue;
            visiblePageCount++;
            const data = memory.pageDataMap.get(page);
            const img = page.querySelector('img');
            const hasSrc = !!img?.getAttribute('src');
            const loaded = !!img?.complete && (img.naturalWidth ?? 0) > 0 && (img.naturalHeight ?? 0) > 0;
            if (img) visibleImageCount++;
            if (loaded) loadedImageCount++;
            if (!hasSrc || !loaded) emptyImageCount++;
            if (pageParts.length < 8) {
                pageParts.push(`${data?.key ?? 'unknown'}:top=${Math.round(rect.top - rootRect.top)},bottom=${Math.round(rect.bottom - rootRect.top)},src=${hasSrc ? 1 : 0},complete=${img?.complete ? 1 : 0},natural=${img?.naturalWidth ?? 0}x${img?.naturalHeight ?? 0}`);
            }
        }

        appState.log.emit('reader-visual-snapshot', {
            source,
            mangaId: appState.manga.activeManga?.id ?? null,
            currentChapterId: appState.reader.currentChapterId,
            scrollTop: Math.round(root.scrollTop),
            clientHeight: Math.round(root.clientHeight),
            sections: sectionParts.slice(0, 6).join('|'),
            pages: pageParts.join('|'),
            visiblePageCount,
            visibleImageCount,
            loadedImageCount,
            emptyImageCount,
        });
    }

    function logReaderSurfaceSnapshot(source: 'after-images' | 'frame-gap', root: HTMLElement, force = false) {
        if (!appState.log.isEnabled) return;
        const now = performance.now();
        if (!force && now - lastSurfaceSnapshotAt < 750) return;
        lastSurfaceSnapshotAt = now;

        const rootRect = root.getBoundingClientRect();
        const stage = root.querySelector<HTMLElement>('.reader-virtual-stage');
        const pages = root.querySelectorAll<HTMLElement>('.reader-page');
        const imgs = root.querySelectorAll<HTMLImageElement>('.reader-page img');
        let imgWithSrc = 0;
        let imgComplete = 0;
        let visiblePages = 0;
        let visibleImages = 0;
        let visibleLoadedImages = 0;
        let visibleNaturalPixels = 0;
        let visibleSections = 0;
        const sectionRanges: string[] = [];

        for (const section of root.querySelectorAll<HTMLElement>('.reader-chapter')) {
            const rect = section.getBoundingClientRect();
            const relativeTop = Math.round(rect.top - rootRect.top);
            const relativeBottom = Math.round(rect.bottom - rootRect.top);
            if (rect.bottom >= rootRect.top && rect.top <= rootRect.bottom) visibleSections++;
            if (sectionRanges.length < 8) {
                sectionRanges.push(`${section.dataset.chapterId ?? 'unknown'}:${relativeTop}-${relativeBottom}`);
            }
        }

        for (const img of imgs) {
            const hasSrc = !!img.getAttribute('src');
            const loaded = img.complete && img.naturalWidth > 0 && img.naturalHeight > 0;
            if (hasSrc) imgWithSrc++;
            if (loaded) imgComplete++;
        }

        for (const page of pages) {
            const rect = page.getBoundingClientRect();
            if (rect.bottom < rootRect.top || rect.top > rootRect.bottom) continue;
            visiblePages++;
            const img = page.querySelector('img');
            if (!img) continue;
            visibleImages++;
            if (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
                visibleLoadedImages++;
                visibleNaturalPixels += img.naturalWidth * img.naturalHeight;
            }
        }

        const rootStyle = getComputedStyle(root);
        appState.log.emit('reader-surface-snapshot', {
            source,
            mangaId: appState.manga.activeManga?.id ?? null,
            currentChapterId: appState.reader.currentChapterId,
            scrollTop: Math.round(root.scrollTop),
            clientHeight: Math.round(root.clientHeight),
            scrollHeight: Math.round(root.scrollHeight),
            stageHeight: Math.round(stage?.getBoundingClientRect().height ?? 0),
            registeredPages: memory.registeredPageCount,
            blobUrls: memory.blobUrlCount,
            loadingImages: memory.loadingCount,
            chapterSections: root.querySelectorAll('.reader-chapter').length,
            pageElements: pages.length,
            imgElements: imgs.length,
            imgWithSrc,
            imgComplete,
            visiblePages,
            visibleImages,
            visibleLoadedImages,
            visibleNaturalMegapixels: Math.round(visibleNaturalPixels / 10_000) / 100,
            visibleSections,
            frameEpoch: appState.reader.windowFrameEpoch,
            sectionRanges: sectionRanges.join('|'),
            transformActive: rootStyle.transform !== 'none' || root.style.transform !== '',
            rootClasses: root.className.toString(),
        });

        if (pages.length > 0 && visiblePages === 0) {
            appState.log.emit('reader-window-coverage-miss', {
                source,
                mangaId: appState.manga.activeManga?.id ?? null,
                currentChapterId: appState.reader.currentChapterId,
                frameEpoch: appState.reader.windowFrameEpoch,
                scrollTop: Math.round(root.scrollTop),
                clientHeight: Math.round(root.clientHeight),
                scrollHeight: Math.round(root.scrollHeight),
                stageHeight: Math.round(stage?.getBoundingClientRect().height ?? 0),
                chapterSections: root.querySelectorAll('.reader-chapter').length,
                pageElements: pages.length,
                visibleSections,
                sectionRanges: sectionRanges.join('|'),
            });
        }
    }

    function queueWindowReconcile(source: 'scroll' | 'visible' | 'retry' = 'scroll') {
        if (windowReconcileTimer != null) return;
        const root = getReaderRoot();
        if (source === 'scroll' && root) {
            const threshold = Math.max(240, root.clientHeight * SCROLL_RECONCILE_STEP_VIEWPORTS);
            const sameViewport = root.clientHeight === lastReconcileClientHeight;
            if (sameViewport && Number.isFinite(lastReconcileScrollTop) && Math.abs(root.scrollTop - lastReconcileScrollTop) < threshold) {
                return;
            }
        }
        const queuedAt = performance.now();
        const queuedProjectionEpoch = domProjectionEpoch;
        windowReconcileTimer = setTimeout(() => {
            windowReconcileTimer = null;
            reconcileReaderWindow(source, undefined, queuedAt, undefined, queuedProjectionEpoch);
        }, 0);
    }

    function cancelScrollSettledTransaction(reason: 'scroll' | 'teardown' = 'scroll') {
        const hadTimer = scrollSettledTimer != null;
        if (scrollSettledTimer != null) {
            clearTimeout(scrollSettledTimer);
            scrollSettledTimer = null;
        }
        scrollSettledGeneration++;
        if (reason === 'scroll' && hadTimer) {
            const root = getReaderRoot();
            appState.log.emit('reader-scroll-settle', {
                mangaId: appState.manga.activeManga?.id ?? null,
                phase: 'cancelled',
                generation: scrollSettledGeneration,
                stableSamples: scrollSettledStableSamples,
                scrollTop: Math.round(root?.scrollTop ?? 0),
                delta: 0,
                queuedForMs: scrollSettledQueuedAt === 0 ? 0 : Math.round(performance.now() - scrollSettledQueuedAt),
            });
        }
        scrollSettledStableSamples = 0;
    }

    function queueScrollSettledTransaction(root: HTMLElement) {
        if (scrollSettledTimer != null) clearTimeout(scrollSettledTimer);
        const generation = scrollSettledGeneration;
        scrollSettledQueuedAt = performance.now();
        scrollSettledLastTop = root.scrollTop;
        scrollSettledStableSamples = 0;
        appState.log.emit('reader-scroll-settle', {
            mangaId: appState.manga.activeManga?.id ?? null,
            phase: 'queued',
            generation,
            stableSamples: 0,
            scrollTop: Math.round(root.scrollTop),
            delta: 0,
            queuedForMs: 0,
        });

        const sample = () => {
            const currentRoot = getReaderRoot();
            if (!currentRoot || generation !== scrollSettledGeneration) return;
            const delta = currentRoot.scrollTop - scrollSettledLastTop;
            if (Math.abs(delta) <= SCROLL_SETTLED_EPSILON_PX) {
                scrollSettledStableSamples++;
            } else {
                scrollSettledStableSamples = 0;
                scrollSettledLastTop = currentRoot.scrollTop;
            }

            if (scrollSettledStableSamples < SCROLL_SETTLED_REQUIRED_SAMPLES) {
                appState.log.emit('reader-scroll-settle', {
                    mangaId: appState.manga.activeManga?.id ?? null,
                    phase: 'sample',
                    generation,
                    stableSamples: scrollSettledStableSamples,
                    scrollTop: Math.round(currentRoot.scrollTop),
                    delta: Math.round(delta),
                    queuedForMs: Math.round(performance.now() - scrollSettledQueuedAt),
                });
                scrollSettledTimer = setTimeout(sample, SCROLL_SETTLED_SAMPLE_MS);
                return;
            }

            scrollSettledTimer = null;
            appState.reader.setScrollActivity('settled', 'scroll-settled');
            appState.log.emit('reader-scroll-settle', {
                mangaId: appState.manga.activeManga?.id ?? null,
                phase: 'settled',
                generation,
                stableSamples: scrollSettledStableSamples,
                scrollTop: Math.round(currentRoot.scrollTop),
                delta: Math.round(delta),
                queuedForMs: Math.round(performance.now() - scrollSettledQueuedAt),
            });
            reconcileReaderWindow('visible', currentRoot.scrollTop, scrollSettledQueuedAt);
            scheduleVirtualImages(currentRoot);
            if (appState.reader.pendingLayoutMeasurementCount > 0) {
                queueIdleLayoutPromotion('layout');
            }
        };

        scrollSettledTimer = setTimeout(sample, SCROLL_SETTLED_SAMPLE_MS);
    }

    function queueScrollIdleTransaction(root: HTMLElement) {
        if (scrollIdleTimer != null) clearTimeout(scrollIdleTimer);
        scrollIdleTimer = setTimeout(() => {
            scrollIdleTimer = null;
            appState.reader.setScrollActivity('idle', 'scroll-idle');
            reconcileReaderWindow('visible', root.scrollTop);
            scheduleVirtualImages(root);
            queueScrollSettledTransaction(root);
        }, SCROLL_IDLE_DELAY_MS);
    }

    function startFrameProbe() {
        if (!READER_DIAGNOSTICS.frameGapProbe) return;
        if (!appState.log.isEnabled) return;
        if (frameRaf != null) return;
        lastFrameAt = performance.now();
        const loop = () => {
            const now = performance.now();
            const gapMs = now - lastFrameAt;
            lastFrameAt = now;
            if (gapMs > 45) {
                const root = getReaderRoot();
                appState.log.emit('reader-frame-gap', {
                    source: 'raf',
                    gapMs: Math.round(gapMs),
                    scrollTop: Math.round(root?.scrollTop ?? 0),
                    pendingMeasurements: appState.reader.pendingLayoutMeasurementCount,
                });
                if (root) logReaderSurfaceSnapshot('frame-gap', root);
            }
            frameRaf = requestAnimationFrame(loop);
        };
        frameRaf = requestAnimationFrame(loop);
    }

    function stopFrameProbe() {
        if (frameRaf == null) return;
        cancelAnimationFrame(frameRaf);
        frameRaf = null;
        lastFrameAt = 0;
    }

    function queuePageTrack(now = performance.now()) {
        if (now - lastPageTrackAt < PAGE_TRACK_INTERVAL_MS) return;
        const currentRoot = getReaderRoot();
        if (!currentRoot) return;
        lastPageTrackAt = now;
        pageTracker.handleScroll(currentRoot, memory.pageDataMap, [appState.reader.layoutChapterId, appState.reader.currentChapterId], (visible) => {
            appState.reader.trackVisiblePage(visible.chapterId, visible.pageIndex, visible.scrollOffset, 'scroll', visible);
        });
    }

    function queueIdleLayoutPromotion(source: 'scroll' | 'layout' = 'scroll') {
        const root = getReaderRoot();
        const now = performance.now();
        if (idleLayoutTimer == null) {
            idleLayoutSequence++;
            idleLayoutQueuedAt = now;
            idleLayoutResetCount = 0;
            idleLayoutSource = source;
            appState.log.emit('reader-layout-idle-timer', {
                phase: 'queued',
                mangaId: appState.manga.activeManga?.id ?? null,
                sequence: idleLayoutSequence,
                delayMs: IDLE_LAYOUT_DELAY_MS,
                queuedForMs: 0,
                sinceLastResetMs: 0,
                resetCount: idleLayoutResetCount,
                pendingMeasurements: appState.reader.pendingLayoutMeasurementCount,
                scrollTop: Math.round(root?.scrollTop ?? 0),
                source,
            });
        } else {
            clearTimeout(idleLayoutTimer);
            idleLayoutResetCount++;
            if (source === 'scroll') idleLayoutSource = source;
        }
        idleLayoutLastResetAt = now;
        idleLayoutTimer = setTimeout(() => {
            idleLayoutTimer = null;
            void runIdleLayoutPromotion();
        }, IDLE_LAYOUT_DELAY_MS);
    }

    async function runIdleLayoutPromotion() {
        const now = performance.now();
        const root = getReaderRoot();
        if (!root) {
            appState.log.emit('reader-layout-idle-timer', {
                phase: 'fired',
                mangaId: appState.manga.activeManga?.id ?? null,
                sequence: idleLayoutSequence,
                delayMs: IDLE_LAYOUT_DELAY_MS,
                queuedForMs: Math.round(now - idleLayoutQueuedAt),
                sinceLastResetMs: Math.round(now - idleLayoutLastResetAt),
                resetCount: idleLayoutResetCount,
                pendingMeasurements: appState.reader.pendingLayoutMeasurementCount,
                scrollTop: 0,
                result: 'no-root',
                source: idleLayoutSource,
            });
            return;
        }
        if (!appState.reader.isScrollSettled) {
            appState.log.emit('reader-layout-idle-timer', {
                phase: 'fired',
                mangaId: appState.manga.activeManga?.id ?? null,
                sequence: idleLayoutSequence,
                delayMs: IDLE_LAYOUT_DELAY_MS,
                queuedForMs: Math.round(now - idleLayoutQueuedAt),
                sinceLastResetMs: Math.round(now - idleLayoutLastResetAt),
                resetCount: idleLayoutResetCount,
                pendingMeasurements: appState.reader.pendingLayoutMeasurementCount,
                scrollTop: Math.round(root.scrollTop),
                result: 'waiting-for-settle',
                source: idleLayoutSource,
            });
            queueScrollSettledTransaction(root);
            return;
        }
        appState.reader.recordChapterMeasurements(measureChapterHeights(root));
        const anchor = findVisualAnchor(root);
        appState.log.emit('reader-layout-anchor-choice', {
            mangaId: appState.manga.activeManga?.id ?? null,
            currentChapterId: appState.reader.currentChapterId,
            layoutChapterId: appState.reader.layoutChapterId,
            anchorKey: anchor?.key ?? null,
            selection: anchor?.selection ?? 'none',
            ownerChapterId: anchor?.ownerChapterId ?? null,
        });
        const result = appState.reader.promotePendingMeasurements(anchor?.key ?? null);
        appState.log.emit('reader-layout-idle-timer', {
            phase: 'fired',
            mangaId: appState.manga.activeManga?.id ?? null,
            sequence: idleLayoutSequence,
            delayMs: IDLE_LAYOUT_DELAY_MS,
            queuedForMs: Math.round(now - idleLayoutQueuedAt),
            sinceLastResetMs: Math.round(now - idleLayoutLastResetAt),
            resetCount: idleLayoutResetCount,
            pendingMeasurements: appState.reader.pendingLayoutMeasurementCount,
            scrollTop: Math.round(root.scrollTop),
            result: result.changed ? 'promoted' : 'unchanged',
            source: idleLayoutSource,
        });
        if (!result.changed) return;
        await tick();
        restoreVisualAnchor(root, anchor);
        reconcileReaderWindow('visible');
    }

    function findVisualAnchor(root: HTMLElement): VisualAnchor | null {
        const rootRect = root.getBoundingClientRect();
        const probeY = rootRect.top + rootRect.height * 0.35;
        const pages: Array<{ element: HTMLElement; key: string; chapterId: string; distance: number }> = [];
        for (const page of root.querySelectorAll<HTMLElement>('.reader-page')) {
            const rect = page.getBoundingClientRect();
            if (rect.bottom < rootRect.top || rect.top > rootRect.bottom) continue;
            const data = memory.pageDataMap.get(page);
            if (!data) continue;
            const distance = rect.top <= probeY && rect.bottom >= probeY
                ? 0
                : Math.min(Math.abs(rect.top - probeY), Math.abs(rect.bottom - probeY));
            pages.push({
                element: page,
                key: data.key,
                chapterId: chapterIdFromPageKey(data.key),
                distance,
            });
        }
        const ownerChapterIds = [
            appState.reader.layoutChapterId,
            appState.reader.currentChapterId,
        ].filter((id): id is string => !!id);
        for (const ownerChapterId of ownerChapterIds) {
            const owned = pages
                .filter(page => page.chapterId === ownerChapterId)
                .sort((a, b) => a.distance - b.distance)[0];
            if (owned) {
                return {
                    key: owned.key,
                    top: owned.element.getBoundingClientRect().top - rootRect.top,
                    selection: 'owner',
                    ownerChapterId,
                };
            }
        }
        const best = pages.sort((a, b) => a.distance - b.distance)[0];
        if (!best) return null;
        return {
            key: best.key,
            top: best.element.getBoundingClientRect().top - rootRect.top,
            selection: 'probe',
            ownerChapterId: null,
        };
    }

    function chapterIdFromPageKey(key: string): string {
        const separator = key.lastIndexOf('-');
        return separator < 0 ? key : key.slice(0, separator);
    }

    function restoreVisualAnchor(root: HTMLElement, anchor: VisualAnchor | null) {
        if (!anchor) return;
        const rootRect = root.getBoundingClientRect();
        for (const page of root.querySelectorAll<HTMLElement>('.reader-page')) {
            const data = memory.pageDataMap.get(page);
            if (data?.key !== anchor.key) continue;
            const from = root.scrollTop;
            const currentTop = page.getBoundingClientRect().top - rootRect.top;
            const delta = currentTop - anchor.top;
            if (Math.abs(delta) <= 1) return;
            root.scrollTop = Math.max(0, root.scrollTop + delta);
            domProjectionEpoch = appState.reader.projectionEpoch;
            if (Math.abs(root.scrollTop - from) > 1) {
                appState.log.emit('reader-scroll-write', {
                    source: 'layout-idle-anchor',
                    from: Math.round(from),
                    to: Math.round(root.scrollTop),
                    delta: Math.round(root.scrollTop - from),
                });
            }
            return;
        }
    }

    function measureChapterHeights(root: HTMLElement): Array<{ chapterId: string; contentHeight: number; slotHeight: number }> {
        const rootRect = root.getBoundingClientRect();
        const sections = root.querySelectorAll<HTMLElement>('.reader-chapter');
        const measurements: Array<{ chapterId: string; contentHeight: number; slotHeight: number }> = [];
        for (const section of sections) {
            const chapterId = section.dataset.chapterId;
            if (!chapterId) continue;
            const rect = section.getBoundingClientRect();
            if (rect.bottom < rootRect.top || rect.top > rootRect.bottom) continue;
            let contentHeight = 0;
            for (const child of Array.from(section.children)) {
                contentHeight += child.getBoundingClientRect().height;
            }
            measurements.push({ chapterId, contentHeight, slotHeight: rect.height });
        }
        return measurements;
    }

    function scrollToCurrentChapterAnchor(root: HTMLElement) {
        const currentId = appState.reader.layoutChapterId;
        if (!currentId || appState.reader.pageRestoreTarget) return;
        const from = root.scrollTop;
        const target = appState.reader.chapterScrollTop(currentId, root.clientWidth) ?? 0;
        root.scrollTop = target;
        domProjectionEpoch = appState.reader.projectionEpoch;
        if (Math.abs(root.scrollTop - from) > 1) {
            appState.log.emit('reader-scroll-write', {
                source: 'initial-current-anchor',
                from: Math.round(from),
                to: Math.round(root.scrollTop),
                delta: Math.round(root.scrollTop - from),
            });
        }
    }

    function restoredPageScrollTop(root: HTMLElement, target: { pageIndex: number; scrollOffset: number }): { scrollTop: number; physicalWindowStart: number } | null {
        const currentId = appState.reader.layoutChapterId;
        const chapter = chapters.find(ch => ch.id === currentId);
        if (!chapter || target.pageIndex < 0 || target.pageIndex >= chapter.pages.length) return null;

        let top = appState.reader.logicalChapterScrollTop(currentId, root.clientWidth) ?? chapter.logicalTop ?? 0;
        top += READER_CHAPTER_SEPARATOR_HEIGHT;
        for (let i = 0; i < target.pageIndex; i++) {
            const page = chapter.pages[i];
            top += page.width && page.height
                ? root.clientWidth * page.height / page.width
                : root.clientWidth * READER_FALLBACK_PAGE_ASPECT_RATIO;
        }
        return appState.reader.physicalTargetForLogical(top + target.scrollOffset, root.clientHeight);
    }

    async function restoreScrollPosition() {
        const root = getReaderRoot();
        if (!root) {
            return;
        }

        appState.reader.primeViewportLayout(root.clientWidth, root.clientHeight);
        scrollCoordinator.beginInitialPosition(root);

        const restore = appState.reader.pageRestoreTarget;
        if (!restore) {
            const from = root.scrollTop;
            const currentId = appState.reader.layoutChapterId;
            const logicalTarget = currentId ? appState.reader.logicalChapterScrollTop(currentId, root.clientWidth) ?? 0 : 0;
            const target = appState.reader.physicalTargetForLogical(logicalTarget, root.clientHeight);
            reconcileReaderWindow('initial', target.scrollTop, undefined, target.physicalWindowStart);
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
            const logicalTarget = currentId ? appState.reader.logicalChapterScrollTop(currentId, root.clientWidth) ?? 0 : 0;
            const target = appState.reader.physicalTargetForLogical(logicalTarget, root.clientHeight);
            reconcileReaderWindow('initial', target.scrollTop, undefined, target.physicalWindowStart);
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

        reconcileReaderWindow('initial', restoreTop.scrollTop, undefined, restoreTop.physicalWindowStart);
        await tick();
        root.scrollTop = restoreTop.scrollTop;
        domProjectionEpoch = appState.reader.projectionEpoch;
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
        const startedAt = performance.now();
        const root = getReaderRoot();
        if (!root) return;
        const previousScrollAt = lastScrollAt;
        const previousScrollTop = lastScrollTop;
        lastScrollAt = startedAt;
        lastScrollTop = root.scrollTop;
        appState.reader.setScrollActivity('scrolling', 'dom-scroll');
        cancelScrollSettledTransaction('scroll');
        scrollCoordinator.noteUserScroll(root);
        queueScrollIdleTransaction(root);
        const visualMs = 0;
        const queueStart = performance.now();
        queueWindowReconcile('scroll');
        const queueMs = performance.now() - queueStart;
        const trackerStart = performance.now();
        queuePageTrack(startedAt);
        const trackerMs = performance.now() - trackerStart;
        const totalMs = performance.now() - startedAt;
        const sinceLastMs = previousScrollAt === 0 ? 0 : startedAt - previousScrollAt;
        const shouldLog = totalMs > 8 || sinceLastMs > 40 || startedAt - lastScrollPerfAt > 1_000;
        if (shouldLog) {
            lastScrollPerfAt = startedAt;
            appState.log.emit('reader-scroll-perf', {
                scrollTop: Math.round(root.scrollTop),
                deltaScroll: Math.round(root.scrollTop - previousScrollTop),
                sinceLastMs: Math.round(sinceLastMs),
                totalMs: Math.round(totalMs),
                visualMs: Math.round(visualMs),
                queueMs: Math.round(queueMs),
                trackerMs: Math.round(trackerMs),
                pageCount: memory.pageDataMap.size,
                pendingMeasurements: appState.reader.pendingLayoutMeasurementCount,
            });
        }
    }

    function handleClose() {
        const root = getReaderRoot();
        if (root) logVisualSnapshot(root, 'close', true);
        const visible = root ? pageTracker.findVisible(root, memory.pageDataMap, [appState.reader.layoutChapterId, appState.reader.currentChapterId]) : null;
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
                domProjectionEpoch = 0;
                lastVisualSnapshotAt = 0;
                failureTimestamps = [];
                slowToastShown = false;
                scrollCoordinator.cancelInitialPosition();
                scrollCoordinator.cancelPrepend();
                stopFrameProbe();
                if (windowReconcileTimer != null) {
                    clearTimeout(windowReconcileTimer);
                    windowReconcileTimer = null;
                }
                if (idleLayoutTimer != null) {
                    clearTimeout(idleLayoutTimer);
                    idleLayoutTimer = null;
                }
                if (scrollIdleTimer != null) {
                    clearTimeout(scrollIdleTimer);
                    scrollIdleTimer = null;
                }
                cancelScrollSettledTransaction('teardown');

                const root = getReaderRoot();
                if (root) root.removeEventListener('scroll', handleScroll);
            }
            return;
        }

        if (!initialized) {
            memory.root = getReaderRoot();
            memory.startSession();
            initialized = true;
            lastReconcileScrollTop = Number.NaN;
            lastReconcileClientHeight = 0;
            domProjectionEpoch = appState.reader.projectionEpoch;
            lastPageTrackAt = 0;

            const root = getReaderRoot();
            if (root) {
                root.addEventListener('scroll', handleScroll, { passive: true });
                startFrameProbe();
            }

            restoreScrollPosition();
        }
        memory.ensureAbortController();
        tick().then(() => {
            scheduleVirtualImages();
            queueIdleLayoutPromotion('layout');
        });
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

<div
    class="reader-wrapper"
    role="application"
    use:swipeBack={{
        onSwipeStart: () => appState.reader.prepareMangaBackTarget(),
        onClose: handleClose,
        ui: appState.ui,
    }}
    use:swipeForward={{
        onPrepare: () => appState.reader.prepareChapterComments(),
        onCommit: () => appState.reader.commitPreparedChapterComments(),
        onCancel: () => appState.reader.cancelPreparedChapterComments(),
        ui: appState.ui,
    }}
>
    {#if chapters.length > 0}
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
                                use:registerPageImage={() => ({ memory, chapterId: chapter.id, pageIndex: i, url: page.url, candidates: page.candidates })}
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
    {:else}
        <div class="empty" style="padding:20px; color: {appState.reader.error ? '#ff6b6b' : '#888'}">
            {appState.reader.error ? loadErrorMessage(appState.reader.error) : 'Loading...'}
        </div>
    {/if}
</div>

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
