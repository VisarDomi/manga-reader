import type { ChapterMeta, LoadedChapter, ReaderPageGeometry } from '$lib/types.js';
import { READER_CHAPTER_SEPARATOR_HEIGHT, READER_FALLBACK_PAGE_ASPECT_RATIO } from '$lib/constants.js';
export type ReaderWindowSource = 'initial' | 'scroll' | 'visible' | 'retry';
export type ReaderScrollDirection = 'up' | 'down' | 'idle';

export type WindowCandidate = {
    chapter: ChapterMeta;
    side: 'prev' | 'next' | 'current';
    distance: number;
    priority: number;
    viewportWidth: number;
};

type EstimateChapterHeight = (chapterId: string, viewportWidth: number) => number;

export type ReaderWindowPlan = {
    candidates: WindowCandidate[];
    nextSlots: LoadedChapter[];
    wantedIds: Set<string>;
    totalHeight: number;
    probeChapterId: string | null;
    logicalScrollTop: number;
    physicalWindowStart: number;
    physicalHeight: number;
    physicalScrollTop: number;
};

type ChapterLayout = {
    chapter: ChapterMeta;
    index: number;
    top: number;
    height: number;
    bottom: number;
};

export class ReaderWindowManager {
    private layoutCacheKey = '';
    private layoutCache: ChapterLayout[] = [];

    plan({
        chapterList,
        loadedChapters,
        scrollTop,
        physicalWindowStart,
        physicalBeforePx,
        physicalAfterPx,
        radiusPx,
        keepPx,
        viewportWidth,
        clientHeight,
        direction,
        heightRevision,
        estimateChapterHeight,
    }: {
        chapterList: ChapterMeta[];
        loadedChapters: LoadedChapter[];
        scrollTop: number;
        physicalWindowStart: number;
        physicalBeforePx: number;
        physicalAfterPx: number;
        radiusPx: number;
        keepPx: number;
        viewportWidth: number;
        clientHeight: number;
        direction: ReaderScrollDirection;
        heightRevision: number;
        estimateChapterHeight: EstimateChapterHeight;
    }): ReaderWindowPlan {
        const layouts = this.getLayout(chapterList, loadedChapters, viewportWidth, heightRevision, estimateChapterHeight);
        const totalHeight = layouts.at(-1)?.bottom ?? Math.max(clientHeight, 1);
        const logicalScrollTop = Math.max(0, Math.min(physicalWindowStart + scrollTop, Math.max(0, totalHeight - clientHeight)));
        const physicalStart = Math.max(0, Math.min(physicalWindowStart, Math.max(0, totalHeight - clientHeight)));
        const physicalEnd = Math.min(totalHeight, physicalStart + physicalBeforePx + clientHeight + physicalAfterPx);
        const physicalHeight = Math.max(clientHeight, physicalEnd - physicalStart);
        const physicalScrollTop = Math.max(0, logicalScrollTop - physicalStart);
        const viewportTop = logicalScrollTop;
        const viewportBottom = viewportTop + clientHeight;
        const probeY = viewportTop + clientHeight * 0.35;
        const probe = this.findLayoutAt(layouts, probeY) ?? this.nearestLayout(layouts, probeY);
        const probeIndex = probe?.index ?? 0;
        const loadTop = Math.max(0, viewportTop - radiusPx);
        const loadBottom = Math.min(totalHeight, viewportBottom + radiusPx);
        const keepTop = Math.max(0, viewportTop - keepPx);
        const keepBottom = Math.min(totalHeight, viewportBottom + keepPx);

        const candidates = layouts
            .filter(layout => this.intersects(layout.top, layout.bottom, loadTop, loadBottom))
            .map(layout => this.toCandidate(layout, probeIndex, viewportTop, viewportBottom, direction, viewportWidth))
            .sort((a, b) => a.priority - b.priority);
        const wantedIds = new Set(candidates.map(candidate => candidate.chapter.id));
        if (probe) wantedIds.add(probe.chapter.id);

        const existing = new Map(loadedChapters.map(ch => [ch.id, ch]));
        const nextSlots = layouts
            .filter(layout => this.intersects(layout.top, layout.bottom, keepTop, keepBottom) || wantedIds.has(layout.chapter.id))
            .map(layout => {
                const slot = existing.get(layout.chapter.id) ?? this.createPlaceholderSlot(layout.chapter, viewportWidth, estimateChapterHeight);
                return {
                    ...slot,
                    estimatedHeight: layout.height,
                    logicalTop: layout.top,
                    logicalHeight: layout.height,
                    virtualTop: layout.top - physicalStart,
                    virtualHeight: layout.height,
                };
            });

        return {
            candidates,
            nextSlots,
            wantedIds,
            totalHeight,
            probeChapterId: probe?.chapter.id ?? null,
            logicalScrollTop,
            physicalWindowStart: physicalStart,
            physicalHeight,
            physicalScrollTop,
        };
    }

    chapterTop(
        chapterList: ChapterMeta[],
        loadedChapters: LoadedChapter[],
        chapterId: string,
        viewportWidth: number,
        heightRevision: number,
        estimateChapterHeight: EstimateChapterHeight,
    ): number | null {
        return this.getLayout(chapterList, loadedChapters, viewportWidth, heightRevision, estimateChapterHeight)
            .find(layout => layout.chapter.id === chapterId)?.top ?? null;
    }

    pageGeometry(
        chapterList: ChapterMeta[],
        loadedChapters: LoadedChapter[],
        viewportWidth: number,
        heightRevision: number,
        estimateChapterHeight: EstimateChapterHeight,
        physicalWindowStart = 0,
    ): ReaderPageGeometry[] {
        const layouts = this.getLayout(chapterList, loadedChapters, viewportWidth, heightRevision, estimateChapterHeight);
        const ready = new Map(loadedChapters.filter(chapter => chapter.pages.length > 0).map(chapter => [chapter.id, chapter]));
        const pages: ReaderPageGeometry[] = [];
        for (const layout of layouts) {
            const chapter = ready.get(layout.chapter.id);
            if (!chapter) continue;
            let top = layout.top - physicalWindowStart + READER_CHAPTER_SEPARATOR_HEIGHT;
            for (let pageIndex = 0; pageIndex < chapter.pages.length; pageIndex++) {
                const page = chapter.pages[pageIndex];
                const height = page.width && page.height
                    ? viewportWidth * page.height / page.width
                    : viewportWidth * READER_FALLBACK_PAGE_ASPECT_RATIO;
                const bottom = top + height;
                pages.push({
                    key: `${chapter.id}-${pageIndex}`,
                    url: page.url,
                    chapterId: chapter.id,
                    pageIndex,
                    top,
                    bottom,
                    height,
                });
                top = bottom;
            }
        }
        return pages;
    }

    clear(): void {
        this.layoutCacheKey = '';
        this.layoutCache = [];
    }

    private getLayout(
        chapterList: ChapterMeta[],
        loadedChapters: LoadedChapter[],
        viewportWidth: number,
        heightRevision: number,
        estimateChapterHeight: EstimateChapterHeight,
    ): ChapterLayout[] {
        const key = this.layoutKey(chapterList, loadedChapters, viewportWidth, heightRevision);
        if (key === this.layoutCacheKey) return this.layoutCache;
        this.layoutCacheKey = key;
        this.layoutCache = this.buildLayout(chapterList, loadedChapters, viewportWidth, estimateChapterHeight);
        return this.layoutCache;
    }

    private layoutKey(chapterList: ChapterMeta[], loadedChapters: LoadedChapter[], viewportWidth: number, heightRevision: number): string {
        const slots = loadedChapters
            .map(chapter => `${chapter.id}:${Math.round(chapter.virtualHeight ?? chapter.estimatedHeight ?? 0)}:${chapter.slotState ?? 'ready'}:${chapter.pages.length}`)
            .join(',');
        return [
            Math.round(viewportWidth),
            heightRevision,
            chapterList.length,
            chapterList.map(chapter => chapter.id).join(','),
            slots,
        ].join('|');
    }

    private buildLayout(
        chapterList: ChapterMeta[],
        loadedChapters: LoadedChapter[],
        viewportWidth: number,
        estimateChapterHeight: EstimateChapterHeight,
    ): ChapterLayout[] {
        const existing = new Map(loadedChapters.map(ch => [ch.id, ch]));
        let top = 0;
        const layouts: ChapterLayout[] = [];
        for (let index = 0; index < chapterList.length; index++) {
            const chapter = chapterList[index];
            const slot = existing.get(chapter.id);
            const height = Math.max(1, slot?.virtualHeight ?? slot?.estimatedHeight ?? estimateChapterHeight(chapter.id, viewportWidth));
            const bottom = top + height;
            layouts.push({ chapter, index, top, height, bottom });
            top = bottom;
        }
        return layouts;
    }

    private findLayoutAt(layouts: ChapterLayout[], y: number): ChapterLayout | null {
        return layouts.find(layout => y >= layout.top && y < layout.bottom) ?? null;
    }

    private nearestLayout(layouts: ChapterLayout[], y: number): ChapterLayout | null {
        if (layouts.length === 0) return null;
        return layouts.reduce((best, layout) => {
            const bestDistance = this.distanceToRange(y, best.top, best.bottom);
            const distance = this.distanceToRange(y, layout.top, layout.bottom);
            return distance < bestDistance ? layout : best;
        }, layouts[0]);
    }

    private toCandidate(
        layout: ChapterLayout,
        probeIndex: number,
        viewportTop: number,
        viewportBottom: number,
        direction: ReaderScrollDirection,
        viewportWidth: number,
    ): WindowCandidate {
        const side = layout.index < probeIndex ? 'prev' : layout.index > probeIndex ? 'next' : 'current';
        const distance = this.distanceBetweenRanges(layout.top, layout.bottom, viewportTop, viewportBottom);
        const step = Math.abs(layout.index - probeIndex);
        const directionBias =
            direction === 'up' && side === 'prev' ? -10_000 :
            direction === 'down' && side === 'next' ? -10_000 :
            direction === 'idle' ? 0 : 10_000;
        const roundRobinBias = side === 'prev' ? 0 : 1;
        return {
            chapter: layout.chapter,
            side,
            distance,
            priority: distance + directionBias + step * 100 + roundRobinBias,
            viewportWidth,
        };
    }

    private intersects(top: number, bottom: number, rangeTop: number, rangeBottom: number): boolean {
        return bottom >= rangeTop && top <= rangeBottom;
    }

    private distanceBetweenRanges(top: number, bottom: number, rangeTop: number, rangeBottom: number): number {
        if (this.intersects(top, bottom, rangeTop, rangeBottom)) return 0;
        return top > rangeBottom ? top - rangeBottom : rangeTop - bottom;
    }

    private distanceToRange(y: number, top: number, bottom: number): number {
        if (y >= top && y <= bottom) return 0;
        return y < top ? top - y : y - bottom;
    }

    private createPlaceholderSlot(
        chapter: ChapterMeta,
        viewportWidth: number,
        estimateChapterHeight: EstimateChapterHeight,
    ): LoadedChapter {
        return {
            id: chapter.id,
            number: chapter.number,
            groupName: chapter.groupName,
            pages: [],
            slotState: 'placeholder',
            estimatedHeight: estimateChapterHeight(chapter.id, viewportWidth),
        };
    }
}
