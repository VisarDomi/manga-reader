import type { LogEmit } from './LogService.js';
import type { ViewMode } from '$lib/types.js';

export type MangaListSource = 'search' | 'favorites' | 'recommendations';

type PerfContext = {
    view: ViewMode;
    backView: ViewMode | null;
    isSwiping: boolean;
    isForwardSwiping: boolean;
    searchResults: number;
    favorites: number;
    activeMangaId: string | null;
    activeChapters: number;
    activeComments: number;
    readerChapters: number;
    readerPages: number;
};

type CoverPhase = 'mount' | 'load' | 'error' | 'missing';

const cardActive = {
    search: 0,
    favorites: 0,
    recommendations: 0,
};

const cardEvents = {
    mounted: { search: 0, favorites: 0, recommendations: 0 },
    unmounted: { search: 0, favorites: 0, recommendations: 0 },
    progressCallbacks: { search: 0, favorites: 0, recommendations: 0 },
    statsCallbacks: { search: 0, favorites: 0, recommendations: 0 },
};

let cardFlushTimer: ReturnType<typeof setTimeout> | null = null;
let coverFlushTimer: ReturnType<typeof setTimeout> | null = null;

const coverEvents: Record<CoverPhase, Record<MangaListSource | 'detail', number>> = {
    mount: { search: 0, favorites: 0, recommendations: 0, detail: 0 },
    load: { search: 0, favorites: 0, recommendations: 0, detail: 0 },
    error: { search: 0, favorites: 0, recommendations: 0, detail: 0 },
    missing: { search: 0, favorites: 0, recommendations: 0, detail: 0 },
};

const coverTiming = {
    loadCount: 0,
    loadTotalMs: 0,
    loadMaxMs: 0,
    errorCount: 0,
    errorTotalMs: 0,
    errorMaxMs: 0,
};

export function cardPerfSnapshot() {
    return {
        searchCards: cardActive.search,
        favoriteCards: cardActive.favorites,
        recommendationCards: cardActive.recommendations,
    };
}

export function recordMangaCardPerf(emit: LogEmit, source: MangaListSource, kind: keyof typeof cardEvents): void {
    if (kind === 'mounted') cardActive[source]++;
    if (kind === 'unmounted') cardActive[source] = Math.max(0, cardActive[source] - 1);
    cardEvents[kind][source]++;

    if (cardFlushTimer != null) return;
    cardFlushTimer = setTimeout(() => {
        cardFlushTimer = null;
        const deltaCount =
            cardEvents.mounted.search
            + cardEvents.mounted.favorites
            + cardEvents.mounted.recommendations
            + cardEvents.unmounted.search
            + cardEvents.unmounted.favorites
            + cardEvents.unmounted.recommendations
            + cardEvents.progressCallbacks.search
            + cardEvents.progressCallbacks.favorites
            + cardEvents.progressCallbacks.recommendations
            + cardEvents.statsCallbacks.search
            + cardEvents.statsCallbacks.favorites
            + cardEvents.statsCallbacks.recommendations;
        if (deltaCount === 0) return;

        const payload = {
            searchCards: cardActive.search,
            favoriteCards: cardActive.favorites,
            recommendationCards: cardActive.recommendations,
            mountedSearch: cardEvents.mounted.search,
            mountedFavorites: cardEvents.mounted.favorites,
            mountedRecommendations: cardEvents.mounted.recommendations,
            unmountedSearch: cardEvents.unmounted.search,
            unmountedFavorites: cardEvents.unmounted.favorites,
            unmountedRecommendations: cardEvents.unmounted.recommendations,
            progressSearch: cardEvents.progressCallbacks.search,
            progressFavorites: cardEvents.progressCallbacks.favorites,
            progressRecommendations: cardEvents.progressCallbacks.recommendations,
            statsSearch: cardEvents.statsCallbacks.search,
            statsFavorites: cardEvents.statsCallbacks.favorites,
            statsRecommendations: cardEvents.statsCallbacks.recommendations,
        };
        cardEvents.mounted.search = 0;
        cardEvents.mounted.favorites = 0;
        cardEvents.mounted.recommendations = 0;
        cardEvents.unmounted.search = 0;
        cardEvents.unmounted.favorites = 0;
        cardEvents.unmounted.recommendations = 0;
        cardEvents.progressCallbacks.search = 0;
        cardEvents.progressCallbacks.favorites = 0;
        cardEvents.progressCallbacks.recommendations = 0;
        cardEvents.statsCallbacks.search = 0;
        cardEvents.statsCallbacks.favorites = 0;
        cardEvents.statsCallbacks.recommendations = 0;
        emit('manga-card-subscription-summary', payload);
    }, 250);
}

export function recordCoverImagePerf(
    emit: LogEmit,
    source: MangaListSource | 'detail',
    phase: CoverPhase,
    hasCover: boolean,
    dtMs: number,
): void {
    coverEvents[phase][source]++;
    if (!hasCover && phase === 'mount') coverEvents.missing[source]++;
    if (phase === 'load') {
        coverTiming.loadCount++;
        coverTiming.loadTotalMs += dtMs;
        coverTiming.loadMaxMs = Math.max(coverTiming.loadMaxMs, dtMs);
    }
    if (phase === 'error') {
        coverTiming.errorCount++;
        coverTiming.errorTotalMs += dtMs;
        coverTiming.errorMaxMs = Math.max(coverTiming.errorMaxMs, dtMs);
    }

    if (coverFlushTimer != null) return;
    coverFlushTimer = setTimeout(() => {
        coverFlushTimer = null;
        const total =
            coverEvents.mount.search + coverEvents.mount.favorites + coverEvents.mount.recommendations + coverEvents.mount.detail
            + coverEvents.load.search + coverEvents.load.favorites + coverEvents.load.recommendations + coverEvents.load.detail
            + coverEvents.error.search + coverEvents.error.favorites + coverEvents.error.recommendations + coverEvents.error.detail
            + coverEvents.missing.search + coverEvents.missing.favorites + coverEvents.missing.recommendations + coverEvents.missing.detail;
        if (total === 0) return;

        emit('manga-cover-image-summary', {
            mountSearch: coverEvents.mount.search,
            mountFavorites: coverEvents.mount.favorites,
            mountRecommendations: coverEvents.mount.recommendations,
            mountDetail: coverEvents.mount.detail,
            loadSearch: coverEvents.load.search,
            loadFavorites: coverEvents.load.favorites,
            loadRecommendations: coverEvents.load.recommendations,
            loadDetail: coverEvents.load.detail,
            errorSearch: coverEvents.error.search,
            errorFavorites: coverEvents.error.favorites,
            errorRecommendations: coverEvents.error.recommendations,
            errorDetail: coverEvents.error.detail,
            missingSearch: coverEvents.missing.search,
            missingFavorites: coverEvents.missing.favorites,
            missingRecommendations: coverEvents.missing.recommendations,
            missingDetail: coverEvents.missing.detail,
            loadAvgMs: coverTiming.loadCount > 0 ? Math.round(coverTiming.loadTotalMs / coverTiming.loadCount) : 0,
            loadMaxMs: Math.round(coverTiming.loadMaxMs),
            errorAvgMs: coverTiming.errorCount > 0 ? Math.round(coverTiming.errorTotalMs / coverTiming.errorCount) : 0,
            errorMaxMs: Math.round(coverTiming.errorMaxMs),
        });

        for (const phase of Object.keys(coverEvents) as CoverPhase[]) {
            coverEvents[phase].search = 0;
            coverEvents[phase].favorites = 0;
            coverEvents[phase].recommendations = 0;
            coverEvents[phase].detail = 0;
        }
        coverTiming.loadCount = 0;
        coverTiming.loadTotalMs = 0;
        coverTiming.loadMaxMs = 0;
        coverTiming.errorCount = 0;
        coverTiming.errorTotalMs = 0;
        coverTiming.errorMaxMs = 0;
    }, 250);
}

export class PerformanceProbe {
    private frameRaf: number | null = null;
    private lastFrameAt = 0;
    private frameBurstStart = 0;
    private frameBurstLast = 0;
    private frameBurstCount = 0;
    private frameBurstTotal = 0;
    private frameBurstMax = 0;

    constructor(
        private emit: LogEmit,
        private context: () => PerfContext,
    ) {}

    start(): void {
        if (typeof window === 'undefined') return;
        this.logObserverStatus();
        this.startFrameProbe();
    }

    stop(): void {
        if (this.frameRaf != null) cancelAnimationFrame(this.frameRaf);
        this.frameRaf = null;
        this.flushFrameBurst();
    }

    private logObserverStatus(): void {
        const performanceObserver = 'PerformanceObserver' in window;
        const supportedEntryTypes = performanceObserver
            && Array.isArray(PerformanceObserver.supportedEntryTypes)
            ? PerformanceObserver.supportedEntryTypes
            : [];
        this.emit('perf-observer-status', {
            performanceObserver,
            supportedEntryTypes: supportedEntryTypes.join(','),
            longtaskSupported: supportedEntryTypes.includes('longtask'),
        });
    }

    private startFrameProbe(): void {
        if (this.frameRaf != null) return;
        this.lastFrameAt = performance.now();
        const loop = () => {
            const now = performance.now();
            const gap = now - this.lastFrameAt;
            this.lastFrameAt = now;
            if (gap > 45) {
                this.recordFrameGap(now, gap);
            } else if (this.frameBurstCount > 0 && now - this.frameBurstLast > 750) {
                this.flushFrameBurst();
            }
            this.frameRaf = requestAnimationFrame(loop);
        };
        this.frameRaf = requestAnimationFrame(loop);
    }

    private recordFrameGap(now: number, gap: number): void {
        if (this.frameBurstCount === 0) {
            this.frameBurstStart = now;
            this.frameBurstTotal = 0;
            this.frameBurstMax = 0;
        }
        this.frameBurstLast = now;
        this.frameBurstCount++;
        this.frameBurstTotal += gap;
        this.frameBurstMax = Math.max(this.frameBurstMax, gap);
        if (this.frameBurstCount >= 12 || now - this.frameBurstStart > 3_000) {
            this.flushFrameBurst();
        }
    }

    private flushFrameBurst(): void {
        if (this.frameBurstCount === 0) return;
        this.emit('perf-frame-burst', {
            source: 'app-raf',
            count: this.frameBurstCount,
            maxGapMs: Math.round(this.frameBurstMax),
            avgGapMs: Math.round(this.frameBurstTotal / this.frameBurstCount),
            durationMs: Math.round(this.frameBurstLast - this.frameBurstStart),
            ...this.context(),
            ...cardPerfSnapshot(),
        });
        this.frameBurstCount = 0;
        this.frameBurstTotal = 0;
        this.frameBurstMax = 0;
    }
}
