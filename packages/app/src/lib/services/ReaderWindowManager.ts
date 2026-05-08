import type { ChapterMeta, LoadedChapter } from '$lib/types.js';
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
};

type ChapterLayout = {
    chapter: ChapterMeta;
    index: number;
    top: number;
    height: number;
    bottom: number;
};

export class ReaderWindowManager {
    plan({
        chapterList,
        loadedChapters,
        scrollTop,
        radiusPx,
        keepPx,
        viewportWidth,
        clientHeight,
        direction,
        estimateChapterHeight,
    }: {
        chapterList: ChapterMeta[];
        loadedChapters: LoadedChapter[];
        scrollTop: number;
        radiusPx: number;
        keepPx: number;
        viewportWidth: number;
        clientHeight: number;
        direction: ReaderScrollDirection;
        estimateChapterHeight: EstimateChapterHeight;
    }): ReaderWindowPlan {
        const layouts = this.buildLayout(chapterList, loadedChapters, viewportWidth, estimateChapterHeight);
        const totalHeight = layouts.at(-1)?.bottom ?? Math.max(clientHeight, 1);
        const viewportTop = Math.max(0, Math.min(scrollTop, Math.max(0, totalHeight - clientHeight)));
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
                    virtualTop: layout.top,
                    virtualHeight: layout.height,
                };
            });

        return { candidates, nextSlots, wantedIds, totalHeight, probeChapterId: probe?.chapter.id ?? null };
    }

    chapterTop(
        chapterList: ChapterMeta[],
        loadedChapters: LoadedChapter[],
        chapterId: string,
        viewportWidth: number,
        estimateChapterHeight: EstimateChapterHeight,
    ): number | null {
        return this.buildLayout(chapterList, loadedChapters, viewportWidth, estimateChapterHeight)
            .find(layout => layout.chapter.id === chapterId)?.top ?? null;
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
