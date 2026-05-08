const USER_SCROLL_TOLERANCE_PX = 2;

type PrependTransaction = {
    anchor: HTMLElement;
    anchorTop: number;
    scrollTop: number;
    invalidated: boolean;
};

type InitialPositionTransaction = {
    scrollTop: number;
    invalidated: boolean;
};

export type PrependCommitResult =
    | { action: 'none'; reason: 'no-transaction' | 'anchor-detached' | 'no-adjustment' }
    | { action: 'cancelled'; reason: 'user-scroll'; delta: number }
    | { action: 'adjusted'; diff: number };

export type InitialPositionTarget = { pageIndex: number; scrollOffset: number } | null;

export type InitialPositionCommitResult =
    | { action: 'cancelled'; reason: 'user-scroll'; delta: number; target: 'top' | 'page' }
    | { action: 'restored'; target: 'page'; pageIndex: number; scrollOffset: number; from: number; to: number }
    | { action: 'reset'; target: 'top'; from: number; to: number }
    | { action: 'fallback'; reason: 'missing-page'; pageIndex: number; from: number; to: number };

export class ReaderScrollCoordinator {
    private prepend: PrependTransaction | null = null;
    private initialPosition: InitialPositionTransaction | null = null;

    beginInitialPosition(root: HTMLElement): void {
        this.initialPosition = {
            scrollTop: root.scrollTop,
            invalidated: false,
        };
    }

    beginPrepend(root: HTMLElement, anchor: HTMLElement | null): void {
        if (!anchor) {
            this.prepend = null;
            return;
        }
        this.prepend = {
            anchor,
            anchorTop: anchor.getBoundingClientRect().top,
            scrollTop: root.scrollTop,
            invalidated: false,
        };
    }

    noteUserScroll(root: HTMLElement): void {
        if (this.initialPosition) {
            const delta = Math.abs(root.scrollTop - this.initialPosition.scrollTop);
            if (delta > USER_SCROLL_TOLERANCE_PX) {
                this.initialPosition.invalidated = true;
            }
        }
        if (!this.prepend) return;
        const delta = Math.abs(root.scrollTop - this.prepend.scrollTop);
        if (delta > USER_SCROLL_TOLERANCE_PX) {
            this.prepend.invalidated = true;
        }
    }

    commitInitialPosition(root: HTMLElement, target: InitialPositionTarget, pages: NodeListOf<Element>): InitialPositionCommitResult {
        const tx = this.initialPosition ?? { scrollTop: root.scrollTop, invalidated: false };
        this.initialPosition = null;

        const scrollDelta = Math.abs(root.scrollTop - tx.scrollTop);
        const targetKind = target && (target.pageIndex > 0 || target.scrollOffset > 0) ? 'page' : 'top';
        if (tx.invalidated || scrollDelta > USER_SCROLL_TOLERANCE_PX) {
            return { action: 'cancelled', reason: 'user-scroll', delta: scrollDelta, target: targetKind };
        }

        const from = root.scrollTop;
        if (targetKind === 'page' && target) {
            const page = pages[target.pageIndex];
            if (!page) {
                root.scrollTop = 0;
                return { action: 'fallback', reason: 'missing-page', pageIndex: target.pageIndex, from, to: root.scrollTop };
            }

            page.scrollIntoView({ block: 'start' });
            root.scrollTop += target.scrollOffset;
            return {
                action: 'restored',
                target: 'page',
                pageIndex: target.pageIndex,
                scrollOffset: target.scrollOffset,
                from,
                to: root.scrollTop,
            };
        }

        root.scrollTop = 0;
        return { action: 'reset', target: 'top', from, to: root.scrollTop };
    }

    commitPrepend(root: HTMLElement): PrependCommitResult {
        const tx = this.prepend;
        this.prepend = null;

        if (!tx) return { action: 'none', reason: 'no-transaction' };
        if (!tx.anchor.isConnected) return { action: 'none', reason: 'anchor-detached' };

        const scrollDelta = Math.abs(root.scrollTop - tx.scrollTop);
        if (tx.invalidated || scrollDelta > USER_SCROLL_TOLERANCE_PX) {
            return { action: 'cancelled', reason: 'user-scroll', delta: scrollDelta };
        }

        const diff = tx.anchor.getBoundingClientRect().top - tx.anchorTop;
        if (Math.abs(diff) <= 1) return { action: 'none', reason: 'no-adjustment' };

        root.scrollTop += diff;
        return { action: 'adjusted', diff };
    }

    cancelPrepend(): void {
        this.prepend = null;
    }

    cancelInitialPosition(): void {
        this.initialPosition = null;
    }
}
