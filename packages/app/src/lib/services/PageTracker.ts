import type { ReaderPageData } from '../types.js';
import { VISIBLE_PAGE_RATIO, SCROLL_DEBOUNCE_MS, HISTORY_SYNC_MS } from '../constants.js';

export class PageTracker {
    private lastVisible: { chapterId: number; pageIndex: number } | null = null;
    private syncTimer: ReturnType<typeof setTimeout> | undefined;
    private scrollTimer: ReturnType<typeof setTimeout> | undefined;

    get current(): { chapterId: number; pageIndex: number } | null {
        return this.lastVisible;
    }

    track(chapterId: number, pageIndex: number): void {
        this.lastVisible = { chapterId, pageIndex };
    }

    scheduleSync(chapterId: number, callback: (chapterId: number, pageIndex: number | undefined) => void): void {
        clearTimeout(this.syncTimer);
        this.syncTimer = setTimeout(() => {
            const pageIndex = this.lastVisible?.chapterId === chapterId
                ? this.lastVisible.pageIndex
                : undefined;
            callback(chapterId, pageIndex);
        }, HISTORY_SYNC_MS);
    }

    flush(callback: (chapterId: number, pageIndex: number) => void): void {
        if (this.lastVisible) {
            callback(this.lastVisible.chapterId, this.lastVisible.pageIndex);
        }
    }

    clearSync(): void {
        clearTimeout(this.syncTimer);
    }

    handleScroll(
        root: HTMLElement,
        pageDataMap: Map<HTMLElement, ReaderPageData>,
        onVisible: (chapterId: number, pageIndex: number) => void,
    ): void {
        clearTimeout(this.scrollTimer);
        this.scrollTimer = setTimeout(() => {
            const rootRect = root.getBoundingClientRect();
            const midY = rootRect.top + rootRect.height * VISIBLE_PAGE_RATIO;

            for (const [node, data] of pageDataMap) {
                const rect = node.getBoundingClientRect();
                if (rect.top <= midY && rect.bottom > midY) {
                    const parts = data.key.split('-');
                    onVisible(Number(parts[0]), Number(parts[1]));
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
