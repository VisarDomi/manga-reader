import type { ChapterMeta, LoadedChapter } from '$lib/types.js';
import { READER_WINDOW_RADIUS_VIEWPORTS } from '$lib/constants.js';

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
};

export class ReaderWindowManager {
    plan({
        chapterList,
        loadedChapters,
        currentIdx,
        radiusPx,
        keepPx,
        viewportWidth,
        clientHeight,
        direction,
        estimateChapterHeight,
    }: {
        chapterList: ChapterMeta[];
        loadedChapters: LoadedChapter[];
        currentIdx: number;
        radiusPx: number;
        keepPx: number;
        viewportWidth: number;
        clientHeight: number;
        direction: ReaderScrollDirection;
        estimateChapterHeight: EstimateChapterHeight;
    }): ReaderWindowPlan {
        const candidates = this.buildCandidates(chapterList, currentIdx, radiusPx, viewportWidth, direction, estimateChapterHeight);
        const currentId = chapterList[currentIdx].id;
        const wantedIds = new Set(candidates.map(candidate => candidate.chapter.id));
        wantedIds.add(currentId);
        const slots = this.reconcileSlots(chapterList, loadedChapters, wantedIds, keepPx, currentIdx, viewportWidth, estimateChapterHeight);
        const nextSlots = this.positionVirtualSlots(slots, currentId, viewportWidth, clientHeight, chapterList, estimateChapterHeight);
        return { candidates, nextSlots, wantedIds };
    }

    positionVirtualSlots(
        slots: LoadedChapter[],
        currentId: string,
        viewportWidth: number,
        clientHeight: number,
        chapterList: ChapterMeta[],
        estimateChapterHeight: EstimateChapterHeight,
    ): LoadedChapter[] {
        if (slots.length === 0) return slots;

        const ordered = [...slots].sort((a, b) => {
            const ai = chapterList.findIndex(ch => ch.id === a.id);
            const bi = chapterList.findIndex(ch => ch.id === b.id);
            return ai - bi;
        });
        const currentIndex = ordered.findIndex(slot => slot.id === currentId);
        const anchorIndex = currentIndex >= 0 ? currentIndex : Math.floor(ordered.length / 2);
        const bufferPx = Math.max(clientHeight, 1) * READER_WINDOW_RADIUS_VIEWPORTS;
        const heights = ordered.map(slot => slot.virtualHeight ?? slot.estimatedHeight ?? estimateChapterHeight(slot.id, viewportWidth));
        const tops = new Map<string, number>();

        tops.set(ordered[anchorIndex].id, bufferPx);
        for (let i = anchorIndex - 1; i >= 0; i--) {
            const nextTop = tops.get(ordered[i + 1].id) ?? bufferPx;
            tops.set(ordered[i].id, nextTop - heights[i]);
        }
        for (let i = anchorIndex + 1; i < ordered.length; i++) {
            const prevTop = tops.get(ordered[i - 1].id) ?? bufferPx;
            tops.set(ordered[i].id, prevTop + heights[i - 1]);
        }

        return ordered.map((slot, i) => ({
            ...slot,
            estimatedHeight: heights[i],
            virtualTop: tops.get(slot.id) ?? bufferPx,
            virtualHeight: heights[i],
        }));
    }

    totalVirtualHeight(slots: LoadedChapter[], clientHeight: number): number {
        const bufferPx = Math.max(clientHeight, 1) * READER_WINDOW_RADIUS_VIEWPORTS;
        const minHeight = Math.max(clientHeight, 1) * (READER_WINDOW_RADIUS_VIEWPORTS * 2 + 1);
        return Math.max(
            minHeight,
            ...slots.map(slot => (slot.virtualTop ?? 0) + (slot.virtualHeight ?? slot.estimatedHeight ?? 0) + bufferPx),
        );
    }

    private buildCandidates(
        chapterList: ChapterMeta[],
        currentIdx: number,
        radiusPx: number,
        viewportWidth: number,
        direction: ReaderScrollDirection,
        estimateChapterHeight: EstimateChapterHeight,
    ): WindowCandidate[] {
        const candidates: WindowCandidate[] = [{
            chapter: chapterList[currentIdx],
            side: 'current',
            distance: 0,
            priority: 0,
            viewportWidth,
        }];
        let prevDistance = 0;
        let nextDistance = 0;
        let step = 1;

        while (currentIdx - step >= 0 || currentIdx + step < chapterList.length) {
            const prev = chapterList[currentIdx - step];
            if (prev && prevDistance < radiusPx) {
                prevDistance += estimateChapterHeight(prev.id, viewportWidth);
                candidates.push({
                    chapter: prev,
                    side: 'prev',
                    distance: prevDistance,
                    priority: this.priority('prev', prevDistance, step, direction),
                    viewportWidth,
                });
            }

            const next = chapterList[currentIdx + step];
            if (next && nextDistance < radiusPx) {
                nextDistance += estimateChapterHeight(next.id, viewportWidth);
                candidates.push({
                    chapter: next,
                    side: 'next',
                    distance: nextDistance,
                    priority: this.priority('next', nextDistance, step, direction),
                    viewportWidth,
                });
            }

            if (prevDistance >= radiusPx && nextDistance >= radiusPx) break;
            step++;
        }

        return candidates.sort((a, b) => a.priority - b.priority);
    }

    private priority(side: 'prev' | 'next', distance: number, step: number, direction: ReaderScrollDirection): number {
        const directionBias =
            direction === 'up' && side === 'prev' ? -10_000 :
            direction === 'down' && side === 'next' ? -10_000 :
            direction === 'idle' ? 0 : 10_000;
        const roundRobinBias = side === 'prev' ? 0 : 1;
        return distance + directionBias + step * 100 + roundRobinBias;
    }

    private reconcileSlots(
        chapterList: ChapterMeta[],
        loadedChapters: LoadedChapter[],
        wantedIds: Set<string>,
        keepPx: number,
        currentIdx: number,
        viewportWidth: number,
        estimateChapterHeight: EstimateChapterHeight,
    ): LoadedChapter[] {
        const existing = new Map(loadedChapters.map(ch => [ch.id, ch]));
        const currentMeta = chapterList[currentIdx];
        const currentHeight = estimateChapterHeight(currentMeta.id, viewportWidth);
        let prevDistance = 0;
        let nextDistance = 0;
        const keepIds = new Set<string>([...wantedIds, currentMeta.id]);

        for (let i = currentIdx - 1; i >= 0 && prevDistance < keepPx; i--) {
            const meta = chapterList[i];
            prevDistance += estimateChapterHeight(meta.id, viewportWidth);
            if (wantedIds.has(meta.id) || prevDistance <= keepPx + currentHeight) keepIds.add(meta.id);
        }
        for (let i = currentIdx + 1; i < chapterList.length && nextDistance < keepPx; i++) {
            const meta = chapterList[i];
            nextDistance += estimateChapterHeight(meta.id, viewportWidth);
            if (wantedIds.has(meta.id) || nextDistance <= keepPx + currentHeight) keepIds.add(meta.id);
        }

        return chapterList
            .filter(meta => keepIds.has(meta.id))
            .map(meta => existing.get(meta.id) ?? this.createPlaceholderSlot(meta, viewportWidth, estimateChapterHeight));
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
