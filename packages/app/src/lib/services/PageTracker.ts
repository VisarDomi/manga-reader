import type { ReaderPageData } from '../types.js';
import { VISIBLE_PAGE_RATIO, SCROLL_DEBOUNCE_MS, HISTORY_SYNC_MS } from '../constants.js';

export type VisiblePageSnapshot = {
    chapterId: string;
    pageIndex: number;
    scrollOffset: number;
    rootScrollTop: number;
    pageTop: number;
    pageBottom: number;
    probeY: number;
    selection: 'owner' | 'probe';
    ownerChapterId?: string | null;
};

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
        ownerChapterIds: Array<string | null | undefined>,
        onVisible: (snapshot: VisiblePageSnapshot) => void,
    ): void {
        clearTimeout(this.scrollTimer);
        this.scrollTimer = setTimeout(() => {
            this.captureVisible(root, pageDataMap, ownerChapterIds, onVisible);
        }, SCROLL_DEBOUNCE_MS);
    }

    captureVisible(
        root: HTMLElement,
        pageDataMap: Map<HTMLElement, ReaderPageData>,
        ownerChapterIds: Array<string | null | undefined>,
        onVisible: (snapshot: VisiblePageSnapshot) => void,
    ): boolean {
        const visible = this.findVisible(root, pageDataMap, ownerChapterIds);
        if (!visible) return false;
        onVisible(visible);
        return true;
    }

    findVisible(
        root: HTMLElement,
        pageDataMap: Map<HTMLElement, ReaderPageData>,
        ownerChapterIds: Array<string | null | undefined> = [],
    ): VisiblePageSnapshot | null {
        const rootRect = root.getBoundingClientRect();
        const midY = rootRect.top + rootRect.height * VISIBLE_PAGE_RATIO;
        const owners = ownerChapterIds.filter((id): id is string => !!id);
        const visiblePages: Array<{ node: HTMLElement; data: ReaderPageData; rect: DOMRect; chapterId: string; pageIndex: number; distance: number }> = [];

        for (const [node, data] of pageDataMap) {
            const rect = node.getBoundingClientRect();
            if (rect.bottom < rootRect.top || rect.top > rootRect.bottom) continue;
            const { chapterId, pageIndex } = this.parsePageKey(data.key);
            const distance = rect.top <= midY && rect.bottom >= midY
                ? 0
                : Math.min(Math.abs(rect.top - midY), Math.abs(rect.bottom - midY));
            visiblePages.push({ node, data, rect, chapterId, pageIndex, distance });
        }

        for (const ownerChapterId of owners) {
            const owned = visiblePages
                .filter(page => page.chapterId === ownerChapterId)
                .sort((a, b) => a.distance - b.distance)[0];
            if (owned) return this.toSnapshot(root, rootRect, midY, owned, 'owner', ownerChapterId);
        }

        const probe = visiblePages
            .filter(page => page.rect.top <= midY && page.rect.bottom > midY)
            .sort((a, b) => a.distance - b.distance)[0];
        if (probe) return this.toSnapshot(root, rootRect, midY, probe, 'probe', null);
        return null;
    }

    private parsePageKey(key: string): { chapterId: string; pageIndex: number } {
        const separator = key.lastIndexOf('-');
        if (separator < 0) return { chapterId: key, pageIndex: 0 };
        return {
            chapterId: key.slice(0, separator),
            pageIndex: Number(key.slice(separator + 1)),
        };
    }

    private toSnapshot(
        root: HTMLElement,
        rootRect: DOMRect,
        midY: number,
        page: { rect: DOMRect; chapterId: string; pageIndex: number },
        selection: 'owner' | 'probe',
        ownerChapterId: string | null,
    ): VisiblePageSnapshot {
        return {
            chapterId: page.chapterId,
            pageIndex: page.pageIndex,
            scrollOffset: rootRect.top - page.rect.top,
            rootScrollTop: root.scrollTop,
            pageTop: page.rect.top - rootRect.top,
            pageBottom: page.rect.bottom - rootRect.top,
            probeY: midY - rootRect.top,
            selection,
            ownerChapterId,
        };
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
