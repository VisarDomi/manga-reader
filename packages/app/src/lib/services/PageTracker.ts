import type { ReaderPageData } from '../types.js';
import { VISIBLE_PAGE_RATIO, SCROLL_DEBOUNCE_MS, HISTORY_SYNC_MS } from '../constants.js';

export class PageTracker {
    private lastVisible: { chapterId: string; pageIndex: number; scrollOffset: number } | null = null;
    private syncTimer: ReturnType<typeof setTimeout> | undefined;
    private scrollTimer: ReturnType<typeof setTimeout> | undefined;

    get current(): { chapterId: string; pageIndex: number } | null {
        return this.lastVisible;
    }

    track(chapterId: string, pageIndex: number, scrollOffset: number): void {
        this.lastVisible = { chapterId, pageIndex, scrollOffset };
    }

    scheduleSync(chapterId: string, callback: (chapterId: string, pageIndex: number | undefined, scrollOffset: number | undefined) => void): void {
        clearTimeout(this.syncTimer);
        this.syncTimer = setTimeout(() => {
            if (this.lastVisible?.chapterId === chapterId) {
                callback(chapterId, this.lastVisible.pageIndex, this.lastVisible.scrollOffset);
            } else {
                callback(chapterId, undefined, undefined);
            }
        }, HISTORY_SYNC_MS);
    }

    flush(callback: (chapterId: string, pageIndex: number, scrollOffset: number) => void): void {
        if (this.lastVisible) {
            callback(this.lastVisible.chapterId, this.lastVisible.pageIndex, this.lastVisible.scrollOffset);
        }
    }

    clearSync(): void {
        clearTimeout(this.syncTimer);
    }

    handleScroll(
        root: HTMLElement,
        pageDataMap: Map<HTMLElement, ReaderPageData>,
        onVisible: (chapterId: string, pageIndex: number, scrollOffset: number) => void,
    ): void {
        clearTimeout(this.scrollTimer);
        this.scrollTimer = setTimeout(() => {
            const rootRect = root.getBoundingClientRect();
            const midY = rootRect.top + rootRect.height * VISIBLE_PAGE_RATIO;

            for (const [node, data] of pageDataMap) {
                const rect = node.getBoundingClientRect();
                if (rect.top <= midY && rect.bottom > midY) {
                    const parts = data.key.split('-');
                    const scrollOffset = rootRect.top - rect.top;
                    onVisible(parts[0], Number(parts[1]), scrollOffset);
                    return;
                }
            }
        }, SCROLL_DEBOUNCE_MS);
    }

    clearScroll(): void {
        clearTimeout(this.scrollTimer);
    }

    destroy(): void {
        clearTimeout(this.syncTimer);
        clearTimeout(this.scrollTimer);
        this.lastVisible = null;
    }
}
