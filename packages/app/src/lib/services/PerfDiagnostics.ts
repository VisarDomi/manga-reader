import type { LogEmit } from './LogService.js';
import type { ViewMode } from '$lib/types.js';

export type MangaListSource = 'search' | 'favorites';

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

const cardActive = {
    search: 0,
    favorites: 0,
};

const cardEvents = {
    mounted: { search: 0, favorites: 0 },
    unmounted: { search: 0, favorites: 0 },
    progressCallbacks: { search: 0, favorites: 0 },
    statsCallbacks: { search: 0, favorites: 0 },
};

let cardFlushTimer: ReturnType<typeof setTimeout> | null = null;

export function cardPerfSnapshot() {
    return {
        searchCards: cardActive.search,
        favoriteCards: cardActive.favorites,
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
            + cardEvents.unmounted.search
            + cardEvents.unmounted.favorites
            + cardEvents.progressCallbacks.search
            + cardEvents.progressCallbacks.favorites
            + cardEvents.statsCallbacks.search
            + cardEvents.statsCallbacks.favorites;
        if (deltaCount === 0) return;

        const payload = {
            searchCards: cardActive.search,
            favoriteCards: cardActive.favorites,
            mountedSearch: cardEvents.mounted.search,
            mountedFavorites: cardEvents.mounted.favorites,
            unmountedSearch: cardEvents.unmounted.search,
            unmountedFavorites: cardEvents.unmounted.favorites,
            progressSearch: cardEvents.progressCallbacks.search,
            progressFavorites: cardEvents.progressCallbacks.favorites,
            statsSearch: cardEvents.statsCallbacks.search,
            statsFavorites: cardEvents.statsCallbacks.favorites,
        };
        cardEvents.mounted.search = 0;
        cardEvents.mounted.favorites = 0;
        cardEvents.unmounted.search = 0;
        cardEvents.unmounted.favorites = 0;
        cardEvents.progressCallbacks.search = 0;
        cardEvents.progressCallbacks.favorites = 0;
        cardEvents.statsCallbacks.search = 0;
        cardEvents.statsCallbacks.favorites = 0;
        emit('manga-card-subscription-summary', payload);
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
