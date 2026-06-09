<script lang="ts">
    import { tick, getContext } from 'svelte';
    import { appState } from '$lib/state/index.svelte.js';
    import { View } from '$lib/logic.js';
    import { loadErrorMessage } from '$lib/state/errors.js';
    import { swipeBack } from '$lib/actions/swipeBack.js';
    import { swipeForward } from '$lib/actions/swipeForward.js';
    import { ReaderMemoryManager } from '$lib/services/ReaderMemoryManager.js';
    import { registerPageImage } from '$lib/actions/observePageImages.js';
    import { ReaderScrollCoordinator, type ScrollAccessor } from '$lib/services/ReaderScrollCoordinator.js';
    import { appDimensions } from '$lib/state/appDimensions.js';
    import MangaList from './MangaList.svelte';
    import {
        READER_CHAPTER_SEPARATOR_HEIGHT,
        READER_FALLBACK_PAGE_ASPECT_RATIO,
    } from '$lib/constants.js';
    import type { LoadedChapter, Manga } from '$lib/types.js';

    const getReaderRoot = getContext<() => HTMLElement | null>('readerRoot');

    const readerScroll = {
        getScrollTop(): number {
            const root = getReaderRoot();
            if (!root) return 0;
            return root.classList.contains('document-scroll')
                ? (window.scrollY || document.documentElement.scrollTop || 0)
                : root.scrollTop;
        },
        setScrollTop(value: number): void {
            const v = Math.max(0, value);
            const root = getReaderRoot();
            if (!root) return;
            if (root.classList.contains('document-scroll')) {
                window.scrollTo(0, v);
            } else {
                root.scrollTop = v;
            }
        },
        clientHeight(): number {
            const root = getReaderRoot();
            if (!root) return 0;
            return root.classList.contains('document-scroll')
                ? (window.innerHeight || document.documentElement.clientHeight || 0)
                : root.clientHeight;
        },
        clientWidth(): number {
            const root = getReaderRoot();
            if (!root) return 0;
            return root.classList.contains('document-scroll')
                ? (window.innerWidth || document.documentElement.clientWidth || 0)
                : root.clientWidth;
        },
        scrollHeight(): number {
            const root = getReaderRoot();
            if (!root) return 0;
            return root.classList.contains('document-scroll')
                ? (document.documentElement.scrollHeight || 0)
                : root.scrollHeight;
        },
        viewportRect(): { top: number; bottom: number; left: number; right: number; height: number; width: number } {
            const root = getReaderRoot();
            if (!root) return { top: 0, bottom: 0, left: 0, right: 0, height: 0, width: 0 };
            if (root.classList.contains('document-scroll')) {
                const h = window.innerHeight || 0;
                return { top: 0, bottom: h, left: 0, right: window.innerWidth || 0, height: h, width: window.innerWidth || 0 };
            }
            const rect = root.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height, width: rect.width };
        },
    };

    function scrollTarget(): HTMLElement | Window {
        const root = getReaderRoot();
        if (root?.classList.contains('document-scroll')) return window;
        return root ?? window;
    }

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
    const recommendations = $derived(appState.manga.activeManga?.recommendations ?? []);
    const showRecommendationsTail = $derived(appState.reader.isAtForwardEnd && recommendations.length > 0);
    const recommendationColumns = $derived(appDimensions.width >= 768 ? 5 : appDimensions.width >= 480 ? 4 : 3);
    const recommendationRowHeight = $derived((appDimensions.width / recommendationColumns) * 1.5);
    const recommendationTailHeight = $derived(showRecommendationsTail ? 58 + Math.ceil(recommendations.length / recommendationColumns) * recommendationRowHeight : 0);
    const lastChapterBottom = $derived(chapters.reduce((max, chapter) => {
        const top = chapter.virtualTop ?? 0;
        const height = Math.max(240, chapter.virtualHeight ?? chapter.estimatedHeight ?? 0);
        return Math.max(max, top + height);
    }, 0));
    const virtualHeight = $derived(Math.max(
        appState.reader.virtualTotalHeight,
        chapters.reduce((sum, chapter) => sum + (chapter.virtualHeight ?? chapter.estimatedHeight ?? 0), 0),
        showRecommendationsTail ? lastChapterBottom + recommendationTailHeight : 0,
    ));

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
    let windowReconcileRaf: number | null = null;
    let layoutPromotionRaf: number | null = null;
    let layoutPromotionSequence = 0;
    let layoutPromotionQueuedAt = 0;
    let layoutPromotionSource: 'layout' | 'projection' = 'layout';
    let lastVisualSnapshotAt = 0;
    let lastSurfaceSnapshotAt = 0;
    let lastScrollPerfAt = 0;
    let lastScrollAt = 0;
    let lastScrollTop = 0;
    let lastReconcileScrollTop = Number.NaN;
    let lastReconcileClientHeight = 0;
    let domProjectionEpoch = 0;
    let projectionTransaction: {
        id: number;
        source: 'initial' | 'scroll' | 'visible' | 'retry';
        frameEpoch: number;
        projectionEpoch: number;
        targetScrollTop: number;
        fromScrollTop: number;
    } | null = null;
    let projectionTransactionId = 0;
    let projectionAckRaf: number | null = null;
    let scrollSessionRaf: number | null = null;
    let scrollIdleTimer: ReturnType<typeof setTimeout> | null = null;
    let scrollSessionActive = false;
    let pointerActive = false;
    let stableScrollTop = 0;
    let stableFrameCount = 0;
    let lastStableAt = 0;
    let lastScrollEventAt = 0;
    let lastNativeScrollendAt = 0;
    let lastPageTrackAt = 0;
    let frameRaf: number | null = null;
    let lastFrameAt = 0;
    const SCROLL_RECONCILE_STEP_VIEWPORTS = 0.75;
    const PAGE_TRACK_INTERVAL_MS = 250;
    const SCROLL_STABLE_EPSILON_PX = 0.5;
    const SCROLL_STABLE_FRAME_COUNT = 4;
    const NATIVE_SCROLLEND_REBASE_DELAY_MS = 100;
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
        if (source !== 'scroll' && appState.reader.pendingLayoutMeasurementCount > 0) {
            queueLayoutPromotion('layout');
        }
        const scrollTop = scrollTopOverride ?? readerScroll.getScrollTop();
        if (source === 'scroll') {
            lastReconcileScrollTop = scrollTop;
            lastReconcileClientHeight = readerScroll.clientHeight();
        }
        const stateStart = performance.now();
        const reconcile = appState.reader.reconcileReaderWindow({
            scrollTop,
            clientHeight: readerScroll.clientHeight(),
            clientWidth: readerScroll.clientWidth(),
            physicalWindowStart: physicalWindowStartOverride,
            projectionEpoch,
        }, source);
        const stateMs = performance.now() - stateStart;
        tick().then(() => {
            const tickStart = performance.now();
            if (reconcile && appState.reader.windowFrameEpoch === reconcile.frameEpoch && Math.abs(readerScroll.getScrollTop() - reconcile.physicalScrollTop) > 1) {
                const from = readerScroll.getScrollTop();
                readerScroll.setScrollTop(reconcile.physicalScrollTop);
                domProjectionEpoch = reconcile.projectionEpoch;
                lastReconcileScrollTop = readerScroll.getScrollTop();
                lastReconcileClientHeight = readerScroll.clientHeight();
                if (reconcile.projectionChanged) {
                    beginProjectionTransaction(source, reconcile.frameEpoch, reconcile.projectionEpoch, from, reconcile.physicalScrollTop);
                }
                appState.log.emit('reader-scroll-write', {
                    source: 'physical-rebase',
                    frameEpoch: reconcile.frameEpoch,
                    projectionEpoch: reconcile.projectionEpoch,
                    from: Math.round(from),
                    to: Math.round(readerScroll.getScrollTop()),
                    delta: Math.round(readerScroll.getScrollTop() - from),
                });
            } else if (reconcile) {
                domProjectionEpoch = reconcile.projectionEpoch;
                if (reconcile.projectionChanged) {
                    beginProjectionTransaction(source, reconcile.frameEpoch, reconcile.projectionEpoch, readerScroll.getScrollTop(), reconcile.physicalScrollTop);
                }
            }
            const imagePerf = scheduleVirtualImages(root);
            appState.reader.prefetchVisibleChapterComments('visible-images');
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
                scrollTop: Math.round(readerScroll.getScrollTop()),
                pendingMeasurements: appState.reader.pendingLayoutMeasurementCount,
            });
        });
    }

    function scheduleVirtualImages(root = getReaderRoot()) {
        if (!root) return null;
        const perf = memory.loadVirtualWindow(
            chapters,
            readerScroll.getScrollTop(),
            readerScroll.clientHeight(),
            readerScroll.clientWidth(),
            appState.reader.pageGeometry(readerScroll.clientWidth()),
            { allowCleanup: projectionTransaction == null },
        );
        return perf;
    }

    function logVisualSnapshot(root: HTMLElement, source: 'initial' | 'scroll' | 'images' | 'close', force = false) {
        if (!READER_DIAGNOSTICS.visualSnapshot) return;
        const now = performance.now();
        if (!force && now - lastVisualSnapshotAt < 750) return;
        lastVisualSnapshotAt = now;

        const vp = readerScroll.viewportRect();
        const sectionParts: string[] = [];
        for (const section of root.querySelectorAll<HTMLElement>('.reader-chapter')) {
            const rect = section.getBoundingClientRect();
            if (rect.bottom < vp.top || rect.top > vp.bottom) continue;
            const chapterId = section.dataset.chapterId ?? '';
            sectionParts.push(`${chapterId}:top=${Math.round(rect.top - vp.top)},bottom=${Math.round(rect.bottom - vp.top)},h=${Math.round(rect.height)}`);
        }

        let visiblePageCount = 0;
        let visibleImageCount = 0;
        let loadedImageCount = 0;
        let emptyImageCount = 0;
        const pageParts: string[] = [];
        for (const page of root.querySelectorAll<HTMLElement>('.reader-page')) {
            const rect = page.getBoundingClientRect();
            if (rect.bottom < vp.top || rect.top > vp.bottom) continue;
            visiblePageCount++;
            const data = memory.pageDataMap.get(page);
            const img = page.querySelector('img');
            const hasSrc = !!img?.getAttribute('src');
            const loaded = !!img?.complete && (img.naturalWidth ?? 0) > 0 && (img.naturalHeight ?? 0) > 0;
            if (img) visibleImageCount++;
            if (loaded) loadedImageCount++;
            if (!hasSrc || !loaded) emptyImageCount++;
            if (pageParts.length < 8) {
                pageParts.push(`${data?.key ?? 'unknown'}:top=${Math.round(rect.top - vp.top)},bottom=${Math.round(rect.bottom - vp.top)},src=${hasSrc ? 1 : 0},complete=${img?.complete ? 1 : 0},natural=${img?.naturalWidth ?? 0}x${img?.naturalHeight ?? 0}`);
            }
        }

        appState.log.emit('reader-visual-snapshot', {
            source,
            mangaId: appState.manga.activeManga?.id ?? null,
            currentChapterId: appState.reader.currentChapterId,
            scrollTop: Math.round(readerScroll.getScrollTop()),
            clientHeight: Math.round(readerScroll.clientHeight()),
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

        const vp = readerScroll.viewportRect();
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
            const relativeTop = Math.round(rect.top - vp.top);
            const relativeBottom = Math.round(rect.bottom - vp.top);
            if (rect.bottom >= vp.top && rect.top <= vp.bottom) visibleSections++;
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
            if (rect.bottom < vp.top || rect.top > vp.bottom) continue;
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
            scrollTop: Math.round(readerScroll.getScrollTop()),
            clientHeight: Math.round(readerScroll.clientHeight()),
            scrollHeight: Math.round(readerScroll.scrollHeight()),
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
                scrollTop: Math.round(readerScroll.getScrollTop()),
                clientHeight: Math.round(readerScroll.clientHeight()),
                scrollHeight: Math.round(readerScroll.scrollHeight()),
                stageHeight: Math.round(stage?.getBoundingClientRect().height ?? 0),
                chapterSections: root.querySelectorAll('.reader-chapter').length,
                pageElements: pages.length,
                visibleSections,
                sectionRanges: sectionRanges.join('|'),
            });
        }
    }

    function beginProjectionTransaction(
        source: 'initial' | 'scroll' | 'visible' | 'retry',
        frameEpoch: number,
        projectionEpoch: number,
        fromScrollTop: number,
        targetScrollTop: number,
    ) {
        projectionTransaction = {
            id: ++projectionTransactionId,
            source,
            frameEpoch,
            projectionEpoch,
            targetScrollTop,
            fromScrollTop,
        };
        appState.reader.setScrollActivity('programmatic', 'projection-transaction');
        appState.log.emit('reader-projection-transaction', {
            phase: 'begin',
            source,
            id: projectionTransaction.id,
            frameEpoch,
            projectionEpoch,
            from: Math.round(fromScrollTop),
            to: Math.round(targetScrollTop),
            observed: Math.round(targetScrollTop),
            delta: Math.round(targetScrollTop - fromScrollTop),
        });
        queueProjectionAck();
    }

    function queueProjectionAck() {
        if (projectionAckRaf != null) cancelAnimationFrame(projectionAckRaf);
        projectionAckRaf = requestAnimationFrame(() => {
            projectionAckRaf = null;
            acknowledgeProjectionTransaction();
        });
    }

    function acknowledgeProjectionTransaction(): boolean {
        const tx = projectionTransaction;
        if (!tx) return false;
        const observed = readerScroll.getScrollTop();
        const delta = observed - tx.targetScrollTop;
        if (Math.abs(delta) > 1) {
            readerScroll.setScrollTop(tx.targetScrollTop);
            domProjectionEpoch = tx.projectionEpoch;
            appState.log.emit('reader-projection-transaction', {
                phase: 'reapply',
                source: tx.source,
                id: tx.id,
                frameEpoch: tx.frameEpoch,
                projectionEpoch: tx.projectionEpoch,
                from: Math.round(tx.fromScrollTop),
                to: Math.round(tx.targetScrollTop),
                observed: Math.round(observed),
                delta: Math.round(delta),
            });
            queueProjectionAck();
            return false;
        }

        appState.log.emit('reader-projection-transaction', {
            phase: 'ack',
            source: tx.source,
            id: tx.id,
            frameEpoch: tx.frameEpoch,
            projectionEpoch: tx.projectionEpoch,
            from: Math.round(tx.fromScrollTop),
            to: Math.round(tx.targetScrollTop),
            observed: Math.round(observed),
            delta: Math.round(delta),
        });
        projectionTransaction = null;
        domProjectionEpoch = tx.projectionEpoch;
        appState.reader.setScrollActivity('settled', 'projection-ack');
        if (appState.reader.pendingLayoutMeasurementCount > 0) {
            queueLayoutPromotion('projection');
        }
        return true;
    }

    function cancelScrollIdle(reason: string) {
        if (scrollIdleTimer != null) {
            clearTimeout(scrollIdleTimer);
            scrollIdleTimer = null;
            const now = performance.now();
            appState.log.emit('reader-scroll-session', {
                phase: 'idle-cancelled',
                mangaId: appState.manga.activeManga?.id ?? null,
                scrollTop: Math.round(readerScroll.getScrollTop()),
                reason,
                sinceStableMs: lastStableAt > 0 ? Math.round(now - lastStableAt) : null,
                sinceLastScrollMs: lastScrollEventAt > 0 ? Math.round(now - lastScrollEventAt) : null,
                sinceLastScrollendMs: lastNativeScrollendAt > 0 ? Math.round(now - lastNativeScrollendAt) : null,
            });
        }
    }

    function stopScrollSessionMonitor(reason: string) {
        if (scrollSessionRaf != null) {
            cancelAnimationFrame(scrollSessionRaf);
            scrollSessionRaf = null;
        }
        cancelScrollIdle(reason);
        stableFrameCount = 0;
    }

    function startScrollSession(source: string, root: HTMLElement) {
        cancelScrollIdle(source);
        stableScrollTop = readerScroll.getScrollTop();
        stableFrameCount = 0;
        if (!scrollSessionActive) {
            scrollSessionActive = true;
            appState.log.emit('reader-scroll-session', {
                phase: 'start',
                mangaId: appState.manga.activeManga?.id ?? null,
                scrollTop: Math.round(readerScroll.getScrollTop()),
                reason: source,
            });
        }
        if (scrollSessionRaf == null) {
            scrollSessionRaf = requestAnimationFrame(observeScrollSession);
        }
    }

    function observeScrollSession() {
        scrollSessionRaf = null;
        const root = getReaderRoot();
        if (!root || projectionTransaction || pointerActive || appState.ui.isSwiping || appState.ui.isForwardSwiping) {
            if (root && scrollSessionActive) {
                stableScrollTop = readerScroll.getScrollTop();
                stableFrameCount = 0;
                scrollSessionRaf = requestAnimationFrame(observeScrollSession);
            }
            return;
        }

        const delta = Math.abs(readerScroll.getScrollTop() - stableScrollTop);
        if (delta > SCROLL_STABLE_EPSILON_PX) {
            stableScrollTop = readerScroll.getScrollTop();
            stableFrameCount = 0;
            cancelScrollIdle('scroll-moved');
            scrollSessionRaf = requestAnimationFrame(observeScrollSession);
            return;
        }

        stableFrameCount++;
        if (stableFrameCount < SCROLL_STABLE_FRAME_COUNT) {
            scrollSessionRaf = requestAnimationFrame(observeScrollSession);
            return;
        }

        appState.log.emit('reader-scroll-session', {
            phase: 'stable',
            mangaId: appState.manga.activeManga?.id ?? null,
            scrollTop: Math.round(readerScroll.getScrollTop()),
            stableFrames: stableFrameCount,
            quietMs: 0,
            edge: edgePressure(root),
            sinceLastScrollMs: lastScrollEventAt > 0 ? Math.round(performance.now() - lastScrollEventAt) : null,
            sinceLastScrollendMs: lastNativeScrollendAt > 0 ? Math.round(performance.now() - lastNativeScrollendAt) : null,
        });
        lastStableAt = performance.now();
    }

    function scheduleIdleRebaseGrant(scrollTopAtStable: number, delayMs: number, reason: string) {
        if (scrollIdleTimer != null) return;
        scrollIdleTimer = setTimeout(() => {
            scrollIdleTimer = null;
            const root = getReaderRoot();
            if (!root) return;
            if (projectionTransaction) {
                startScrollSession('projection-active', root);
                return;
            }
            if (pointerActive || appState.ui.isSwiping || appState.ui.isForwardSwiping) {
                startScrollSession('gesture-active', root);
                return;
            }
            if (Math.abs(readerScroll.getScrollTop() - scrollTopAtStable) > SCROLL_STABLE_EPSILON_PX) {
                startScrollSession('scroll-moved-during-idle-delay', root);
                return;
            }

            scrollSessionActive = false;
            stableFrameCount = 0;
            appState.reader.setScrollActivity('settled', 'scroll-session-idle');
            appState.log.emit('reader-scroll-session', {
                phase: 'idle-granted',
                mangaId: appState.manga.activeManga?.id ?? null,
                scrollTop: Math.round(readerScroll.getScrollTop()),
                stableFrames: SCROLL_STABLE_FRAME_COUNT,
                quietMs: delayMs,
                reason,
                edge: edgePressure(root),
                sinceStableMs: lastStableAt > 0 ? Math.round(performance.now() - lastStableAt) : null,
                sinceLastScrollMs: lastScrollEventAt > 0 ? Math.round(performance.now() - lastScrollEventAt) : null,
                sinceLastScrollendMs: lastNativeScrollendAt > 0 ? Math.round(performance.now() - lastNativeScrollendAt) : null,
            });
            requestIdleRebaseIfNeeded(root);
        }, delayMs);
    }

    function requestIdleRebaseIfNeeded(root: HTMLElement) {
        const target = appState.reader.rebaseTargetIfNeeded(readerScroll.getScrollTop(), readerScroll.clientHeight());
        if (!target) {
            appState.log.emit('reader-scroll-session', {
                phase: 'rebase-skipped',
                mangaId: appState.manga.activeManga?.id ?? null,
                scrollTop: Math.round(readerScroll.getScrollTop()),
                reason: 'no-edge-pressure',
                sinceStableMs: lastStableAt > 0 ? Math.round(performance.now() - lastStableAt) : null,
                sinceLastScrollMs: lastScrollEventAt > 0 ? Math.round(performance.now() - lastScrollEventAt) : null,
                sinceLastScrollendMs: lastNativeScrollendAt > 0 ? Math.round(performance.now() - lastNativeScrollendAt) : null,
            });
            return;
        }
        appState.log.emit('reader-scroll-session', {
            phase: 'rebase-request',
            mangaId: appState.manga.activeManga?.id ?? null,
            scrollTop: Math.round(readerScroll.getScrollTop()),
            edge: target.edge === 'prev' ? 'top' : 'bottom',
            sinceStableMs: lastStableAt > 0 ? Math.round(performance.now() - lastStableAt) : null,
            sinceLastScrollMs: lastScrollEventAt > 0 ? Math.round(performance.now() - lastScrollEventAt) : null,
            sinceLastScrollendMs: lastNativeScrollendAt > 0 ? Math.round(performance.now() - lastNativeScrollendAt) : null,
        });
        reconcileReaderWindow('scroll', target.scrollTop, undefined, target.physicalWindowStart);
    }

    function edgePressure(root: HTMLElement): 'top' | 'bottom' | undefined {
        const target = appState.reader.rebaseTargetIfNeeded(readerScroll.getScrollTop(), readerScroll.clientHeight());
        if (!target) return undefined;
        return target.edge === 'prev' ? 'top' : 'bottom';
    }

    function queueWindowReconcile(source: 'scroll' | 'visible' | 'retry' = 'scroll') {
        if (projectionTransaction) return;
        if (windowReconcileRaf != null) return;
        if (source === 'scroll') {
            const threshold = Math.max(240, readerScroll.clientHeight() * SCROLL_RECONCILE_STEP_VIEWPORTS);
            const sameViewport = readerScroll.clientHeight() === lastReconcileClientHeight;
            if (sameViewport && Number.isFinite(lastReconcileScrollTop) && Math.abs(readerScroll.getScrollTop() - lastReconcileScrollTop) < threshold) {
                return;
            }
        }
        const queuedAt = performance.now();
        const queuedProjectionEpoch = domProjectionEpoch;
        windowReconcileRaf = requestAnimationFrame(() => {
            windowReconcileRaf = null;
            reconcileReaderWindow(source, undefined, queuedAt, undefined, queuedProjectionEpoch);
        });
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
                appState.log.emit('reader-frame-gap', {
                    source: 'raf',
                    gapMs: Math.round(gapMs),
                    scrollTop: Math.round(readerScroll.getScrollTop()),
                    pendingMeasurements: appState.reader.pendingLayoutMeasurementCount,
                });
                const root = getReaderRoot();
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
            visible.rootScrollTop = readerScroll.getScrollTop();
            appState.reader.trackVisiblePage(visible.chapterId, visible.pageIndex, visible.scrollOffset, visible.rootScrollTop, 'scroll', visible);
        });
    }

    function queueLayoutPromotion(source: 'layout' | 'projection' = 'layout') {
        const root = getReaderRoot();
        const now = performance.now();
        if (layoutPromotionRaf == null) {
            layoutPromotionSequence++;
            layoutPromotionQueuedAt = now;
            layoutPromotionSource = source;
            appState.log.emit('reader-layout-promotion-frame', {
                phase: 'queued',
                mangaId: appState.manga.activeManga?.id ?? null,
                sequence: layoutPromotionSequence,
                queuedForMs: 0,
                pendingMeasurements: appState.reader.pendingLayoutMeasurementCount,
                scrollTop: Math.round(readerScroll.getScrollTop()),
                source,
            });
        } else {
            cancelAnimationFrame(layoutPromotionRaf);
            layoutPromotionSource = source;
        }
        layoutPromotionRaf = requestAnimationFrame(() => {
            layoutPromotionRaf = null;
            void runLayoutPromotion();
        });
    }

    async function runLayoutPromotion() {
        const now = performance.now();
        const root = getReaderRoot();
        if (!root) {
            appState.log.emit('reader-layout-promotion-frame', {
                phase: 'fired',
                mangaId: appState.manga.activeManga?.id ?? null,
                sequence: layoutPromotionSequence,
                queuedForMs: Math.round(now - layoutPromotionQueuedAt),
                pendingMeasurements: appState.reader.pendingLayoutMeasurementCount,
                scrollTop: 0,
                result: 'no-root',
                source: layoutPromotionSource,
            });
            return;
        }
        if (projectionTransaction) {
            appState.log.emit('reader-layout-promotion-frame', {
                phase: 'fired',
                mangaId: appState.manga.activeManga?.id ?? null,
                sequence: layoutPromotionSequence,
                queuedForMs: Math.round(now - layoutPromotionQueuedAt),
                pendingMeasurements: appState.reader.pendingLayoutMeasurementCount,
                scrollTop: Math.round(readerScroll.getScrollTop()),
                result: 'projection-active',
                source: layoutPromotionSource,
            });
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
        appState.log.emit('reader-layout-promotion-frame', {
            phase: 'fired',
            mangaId: appState.manga.activeManga?.id ?? null,
            sequence: layoutPromotionSequence,
            queuedForMs: Math.round(now - layoutPromotionQueuedAt),
            pendingMeasurements: appState.reader.pendingLayoutMeasurementCount,
            scrollTop: Math.round(readerScroll.getScrollTop()),
            result: result.changed ? 'promoted' : 'unchanged',
            source: layoutPromotionSource,
        });
        if (!result.changed) return;
        await tick();
        restoreVisualAnchor(root, anchor);
        reconcileReaderWindow('visible');
    }

    function findVisualAnchor(root: HTMLElement): VisualAnchor | null {
        const vp = readerScroll.viewportRect();
        const probeY = vp.top + vp.height * 0.35;
        const pages: Array<{ element: HTMLElement; key: string; chapterId: string; distance: number }> = [];
        for (const page of root.querySelectorAll<HTMLElement>('.reader-page')) {
            const rect = page.getBoundingClientRect();
            if (rect.bottom < vp.top || rect.top > vp.bottom) continue;
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
        const owner = ownerChapterIds
            .map(ownerChapterId => pages
                .filter(page => page.chapterId === ownerChapterId)
                .sort((a, b) => a.distance - b.distance)[0])
            .find((page): page is { element: HTMLElement; key: string; chapterId: string; distance: number } => !!page);
        const probe = pages
            .filter(page => page.distance === 0)
            .sort((a, b) => ownerRank(a.chapterId, ownerChapterIds) - ownerRank(b.chapterId, ownerChapterIds))[0]
            ?? pages.sort((a, b) => a.distance - b.distance)[0];
        const best = owner ?? probe;
        if (!best) return null;
        return {
            key: best.key,
            top: best.element.getBoundingClientRect().top - vp.top,
            selection: owner ? 'owner' : 'probe',
            ownerChapterId: owner ? best.chapterId : null,
        };
    }

    function ownerRank(chapterId: string, ownerChapterIds: string[]): number {
        const index = ownerChapterIds.indexOf(chapterId);
        return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    }

    function chapterIdFromPageKey(key: string): string {
        const separator = key.lastIndexOf('-');
        return separator < 0 ? key : key.slice(0, separator);
    }

    function restoreVisualAnchor(root: HTMLElement, anchor: VisualAnchor | null) {
        if (!anchor) return;
        const vp = readerScroll.viewportRect();
        for (const page of root.querySelectorAll<HTMLElement>('.reader-page')) {
            const data = memory.pageDataMap.get(page);
            if (data?.key !== anchor.key) continue;
            const from = readerScroll.getScrollTop();
            const currentTop = page.getBoundingClientRect().top - vp.top;
            const delta = currentTop - anchor.top;
            if (Math.abs(delta) <= 1) return;
            readerScroll.setScrollTop(Math.max(0, readerScroll.getScrollTop() + delta));
            appState.reader.adoptPhysicalScrollTop(readerScroll.getScrollTop(), 'layout-idle-anchor');
            domProjectionEpoch = appState.reader.projectionEpoch;
            if (Math.abs(readerScroll.getScrollTop() - from) > 1) {
                appState.log.emit('reader-scroll-write', {
                    source: 'layout-idle-anchor',
                    from: Math.round(from),
                    to: Math.round(readerScroll.getScrollTop()),
                    delta: Math.round(readerScroll.getScrollTop() - from),
                });
            }
            return;
        }
    }

    function measureChapterHeights(root: HTMLElement): Array<{ chapterId: string; contentHeight: number; slotHeight: number }> {
        const vp = readerScroll.viewportRect();
        const sections = root.querySelectorAll<HTMLElement>('.reader-chapter');
        const measurements: Array<{ chapterId: string; contentHeight: number; slotHeight: number }> = [];
        for (const section of sections) {
            const chapterId = section.dataset.chapterId;
            if (!chapterId) continue;
            const rect = section.getBoundingClientRect();
            if (rect.bottom < vp.top || rect.top > vp.bottom) continue;
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
        if (!currentId) return;
        const from = readerScroll.getScrollTop();
        const target = appState.reader.chapterScrollTop(currentId, readerScroll.clientWidth()) ?? 0;
        readerScroll.setScrollTop(target);
        appState.reader.adoptPhysicalScrollTop(readerScroll.getScrollTop(), 'initial-current-anchor');
        domProjectionEpoch = appState.reader.projectionEpoch;
        if (Math.abs(readerScroll.getScrollTop() - from) > 1) {
            appState.log.emit('reader-scroll-write', {
                source: 'initial-current-anchor',
                from: Math.round(from),
                to: Math.round(readerScroll.getScrollTop()),
                delta: Math.round(readerScroll.getScrollTop() - from),
            });
        }
    }

    function restoredPageScrollTop(root: HTMLElement, target: { pageIndex: number; scrollOffset: number }): { scrollTop: number; physicalWindowStart: number } | null {
        const currentId = appState.reader.layoutChapterId;
        const chapter = chapters.find(ch => ch.id === currentId);
        if (!chapter || target.pageIndex < 0 || target.pageIndex >= chapter.pages.length) return null;

        let top = appState.reader.logicalChapterScrollTop(currentId, readerScroll.clientWidth()) ?? chapter.logicalTop ?? 0;
        top += READER_CHAPTER_SEPARATOR_HEIGHT;
        for (let i = 0; i < target.pageIndex; i++) {
            const page = chapter.pages[i];
            top += page.width && page.height
                ? readerScroll.clientWidth() * page.height / page.width
                : readerScroll.clientWidth() * READER_FALLBACK_PAGE_ASPECT_RATIO;
        }
        return appState.reader.physicalTargetForLogical(top + target.scrollOffset, readerScroll.clientHeight());
    }

    async function restoreScrollPosition() {
        const root = getReaderRoot();
        if (!root) {
            return;
        }

        appState.reader.primeViewportLayout(readerScroll.clientWidth(), readerScroll.clientHeight());
        scrollCoordinator.beginInitialPosition(readerScroll.getScrollTop());

        const rootScrollTarget = appState.reader.rootScrollRestoreTarget;
        const restore = appState.reader.pageRestoreTarget;
        if (rootScrollTarget != null) {
            const from = readerScroll.getScrollTop();
            reconcileReaderWindow('initial', rootScrollTarget);
            await tick();
            readerScroll.setScrollTop(rootScrollTarget);
            appState.reader.adoptPhysicalScrollTop(readerScroll.getScrollTop(), 'initial-restore-into-view');
            domProjectionEpoch = appState.reader.projectionEpoch;
            scrollCoordinator.cancelInitialPosition();
            appState.log.emit('reader-restore-scroll', {
                action: 'restored',
                target: 'scroll-top',
                scrollTop: Math.round(rootScrollTarget),
                from: Math.round(from),
                to: Math.round(readerScroll.getScrollTop()),
            });
            requestAnimationFrame(() => {
                appState.reader.clearPageRestore();
            });
            return;
        }

        if (!restore) {
            const from = readerScroll.getScrollTop();
            const currentId = appState.reader.layoutChapterId;
            const logicalTarget = currentId ? appState.reader.logicalChapterScrollTop(currentId, readerScroll.clientWidth()) ?? 0 : 0;
            const target = appState.reader.physicalTargetForLogical(logicalTarget, readerScroll.clientHeight());
            reconcileReaderWindow('initial', target.scrollTop, undefined, target.physicalWindowStart);
            await tick();
            scrollToCurrentChapterAnchor(root);
            scrollCoordinator.cancelInitialPosition();
            appState.log.emit('reader-restore-scroll', {
                action: 'reset',
                target: 'top',
                from: Math.round(from),
                to: Math.round(readerScroll.getScrollTop()),
            });
            requestAnimationFrame(() => {
                appState.reader.clearPageRestore();
            });
            return;
        }

        const from = readerScroll.getScrollTop();
        const restoreTop = restoredPageScrollTop(root, restore);
        scrollCoordinator.cancelInitialPosition();
        if (restoreTop == null) {
            appState.reader.clearPageRestore();
            const currentId = appState.reader.layoutChapterId;
            const logicalTarget = currentId ? appState.reader.logicalChapterScrollTop(currentId, readerScroll.clientWidth()) ?? 0 : 0;
            const target = appState.reader.physicalTargetForLogical(logicalTarget, readerScroll.clientHeight());
            reconcileReaderWindow('initial', target.scrollTop, undefined, target.physicalWindowStart);
            await tick();
            scrollToCurrentChapterAnchor(root);
            appState.log.emit('reader-restore-scroll', {
                action: 'fallback',
                reason: 'missing-page',
                target: 'page',
                pageIndex: restore.pageIndex,
                from: Math.round(from),
                to: Math.round(readerScroll.getScrollTop()),
            });
            return;
        }

        reconcileReaderWindow('initial', restoreTop.scrollTop, undefined, restoreTop.physicalWindowStart);
        await tick();
        readerScroll.setScrollTop(restoreTop.scrollTop);
        appState.reader.adoptPhysicalScrollTop(readerScroll.getScrollTop(), 'initial-restore-into-view');
        domProjectionEpoch = appState.reader.projectionEpoch;
        if (Math.abs(readerScroll.getScrollTop() - from) > 1) {
            appState.log.emit('reader-scroll-write', {
                source: 'initial-restore-into-view',
                from: Math.round(from),
                to: Math.round(readerScroll.getScrollTop()),
                delta: Math.round(readerScroll.getScrollTop() - from),
            });
        }
        appState.log.emit('reader-restore-scroll', {
            action: 'restored',
            target: 'page',
            pageIndex: restore.pageIndex,
            scrollOffset: restore.scrollOffset,
            from: Math.round(from),
            to: Math.round(readerScroll.getScrollTop()),
        });

        requestAnimationFrame(() => {
            appState.reader.clearPageRestore();
        });
    }

    function handleScroll() {
        const startedAt = performance.now();
        if (projectionTransaction) {
            acknowledgeProjectionTransaction();
            return;
        }
        if (appState.ui.viewMode !== View.READER && appState.ui.viewMode !== View.CHAPTER_COMMENTS) return;
        const previousScrollAt = lastScrollAt;
        const previousScrollTop = lastScrollTop;
        lastScrollAt = startedAt;
        lastScrollEventAt = startedAt;
        lastScrollTop = readerScroll.getScrollTop();
        appState.reader.setScrollActivity('scrolling', 'dom-scroll');
        const root = getReaderRoot();
        if (root) {
            startScrollSession('dom-scroll', root);
            scrollCoordinator.noteUserScroll(readerScroll.getScrollTop());
        }
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
                scrollTop: Math.round(readerScroll.getScrollTop()),
                deltaScroll: Math.round(readerScroll.getScrollTop() - previousScrollTop),
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
        if (visible) {
            visible.rootScrollTop = readerScroll.getScrollTop();
            appState.reader.trackVisiblePage(visible.chapterId, visible.pageIndex, visible.scrollOffset, visible.rootScrollTop, 'close', visible);
        }
        onClose();
    }

    function handlePointerDown() {
        pointerActive = true;
        const root = getReaderRoot();
        if (root) startScrollSession('pointer-down', root);
    }

    function handlePointerUp() {
        pointerActive = false;
        const root = getReaderRoot();
        if (root) startScrollSession('pointer-up', root);
    }

    function handleReaderScrollend() {
        const root = getReaderRoot();
        if (!root) return;
        const now = performance.now();
        lastNativeScrollendAt = now;
        appState.log.emit('reader-scroll-session', {
            phase: 'native-scrollend',
            mangaId: appState.manga.activeManga?.id ?? null,
            scrollTop: Math.round(readerScroll.getScrollTop()),
            edge: edgePressure(root),
            reason: 'reader',
            sinceStableMs: lastStableAt > 0 ? Math.round(now - lastStableAt) : null,
            sinceLastScrollMs: lastScrollEventAt > 0 ? Math.round(now - lastScrollEventAt) : null,
        });
        cancelScrollIdle('native-scrollend-replaces-stable-grant');
        lastStableAt = now;
        scheduleIdleRebaseGrant(readerScroll.getScrollTop(), NATIVE_SCROLLEND_REBASE_DELAY_MS, 'native-scrollend');
    }

    $effect(() => {
        const count = chapters.length;
        const tailChanged = appState.reader.setTerminalTailHeight(
            count > 0 ? recommendationTailHeight : 0,
            'reader-component',
        );
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
                if (windowReconcileRaf != null) {
                    cancelAnimationFrame(windowReconcileRaf);
                    windowReconcileRaf = null;
                }
                if (layoutPromotionRaf != null) {
                    cancelAnimationFrame(layoutPromotionRaf);
                    layoutPromotionRaf = null;
                }
                if (projectionAckRaf != null) {
                    cancelAnimationFrame(projectionAckRaf);
                    projectionAckRaf = null;
                }
                stopScrollSessionMonitor('reader-unmount');
                pointerActive = false;
                scrollSessionActive = false;
                lastStableAt = 0;
                lastScrollEventAt = 0;
                lastNativeScrollendAt = 0;
                if (projectionTransaction) {
                    appState.log.emit('reader-projection-transaction', {
                        phase: 'cancel',
                        source: projectionTransaction.source,
                        id: projectionTransaction.id,
                        frameEpoch: projectionTransaction.frameEpoch,
                        projectionEpoch: projectionTransaction.projectionEpoch,
                        from: Math.round(projectionTransaction.fromScrollTop),
                        to: Math.round(projectionTransaction.targetScrollTop),
                        observed: Math.round(readerScroll.getScrollTop()),
                        delta: 0,
                    });
                    projectionTransaction = null;
                }

                const root = getReaderRoot();
                const target = scrollTarget();
                target.removeEventListener('scroll', handleScroll);
                if (root) {
                    root.removeEventListener('touchstart', handlePointerDown);
                    root.removeEventListener('touchend', handlePointerUp);
                    root.removeEventListener('touchcancel', handlePointerUp);
                    root.removeEventListener('pointerdown', handlePointerDown);
                    root.removeEventListener('pointerup', handlePointerUp);
                    root.removeEventListener('pointercancel', handlePointerUp);
                }
                target.removeEventListener('scrollend', handleReaderScrollend);
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
            const target = scrollTarget();
            target.addEventListener('scroll', handleScroll, { passive: true });
            if (root) {
                root.addEventListener('touchstart', handlePointerDown, { passive: true });
                root.addEventListener('touchend', handlePointerUp, { passive: true });
                root.addEventListener('touchcancel', handlePointerUp, { passive: true });
                root.addEventListener('pointerdown', handlePointerDown, { passive: true });
                root.addEventListener('pointerup', handlePointerUp, { passive: true });
                root.addEventListener('pointercancel', handlePointerUp, { passive: true });
            }
            target.addEventListener('scrollend', handleReaderScrollend, { passive: true });
            startFrameProbe();

            restoreScrollPosition();
        }
        if (tailChanged && initialized) {
            queueWindowReconcile('visible');
        }
        memory.ensureAbortController();
        tick().then(() => {
            const root = getReaderRoot();
            scheduleVirtualImages(root);
            queueLayoutPromotion('layout');
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

    function openRecommendation(manga: Manga) {
        appState.reader.closeReader();
        appState.manga.updateRecommendationScrollTarget();
        void appState.manga.openManga(manga);
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
                                use:registerPageImage={() => ({ memory, chapterId: chapter.id, pageIndex: i, url: page.url, candidates: page.candidates, criticalCandidates: page.criticalCandidates })}
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
            {#if showRecommendationsTail}
                <section
                    class="reader-recommendations"
                    style="transform:translateY({lastChapterBottom}px); min-height:{recommendationTailHeight}px"
                >
                    <h2>Recommendations</h2>
                    <MangaList manga={recommendations} source="recommendations" onSelect={openRecommendation} />
                </section>
            {/if}
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

.reader-recommendations {
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
    padding-bottom: 24px;
    background: #000;
}

.reader-recommendations h2 {
    margin: 0;
    padding: 18px 12px 12px;
    font-size: 14px;
    line-height: 1.2;
    color: #ddd;
    background: #111;
    border-top: 1px solid #333;
    border-bottom: 1px solid #222;
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
