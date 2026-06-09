export type ScrollAccessor = {
    getScrollTop(): number;
    setScrollTop(value: number): void;
};

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
    | { action: 'adjusted'; diff: number; userDelta: number; anchorTop: number; targetTop: number };

export type InitialPositionTarget = { pageIndex: number; scrollOffset: number } | null;

export type ProgrammaticScrollWrite = {
    source: 'initial-fallback' | 'initial-restore-into-view' | 'initial-restore-offset' | 'initial-reset' | 'initial-current-anchor' | 'prepend-adjust';
    from: number;
    to: number;
};

export type ProgrammaticScrollLogger = (write: ProgrammaticScrollWrite) => void;

export type InitialPositionCommitResult =
    | { action: 'cancelled'; reason: 'user-scroll'; delta: number; target: 'top' | 'page' }
    | { action: 'restored'; target: 'page'; pageIndex: number; scrollOffset: number; from: number; to: number }
    | { action: 'reset'; target: 'top'; from: number; to: number }
    | { action: 'fallback'; reason: 'missing-page'; pageIndex: number; from: number; to: number };

export class ReaderScrollCoordinator {
    private prepend: PrependTransaction | null = null;
    private initialPosition: InitialPositionTransaction | null = null;

    beginInitialPosition(scrollTop: number): void {
        this.initialPosition = {
            scrollTop,
            invalidated: false,
        };
    }

    beginPrepend(scrollTop: number, anchor: HTMLElement | null): void {
        if (!anchor) {
            this.prepend = null;
            return;
        }
        this.prepend = {
            anchor,
            anchorTop: anchor.getBoundingClientRect().top,
            scrollTop,
            invalidated: false,
        };
    }

    noteUserScroll(scrollTop: number): void {
        if (this.initialPosition) {
            const delta = Math.abs(scrollTop - this.initialPosition.scrollTop);
            if (delta > USER_SCROLL_TOLERANCE_PX) {
                this.initialPosition.invalidated = true;
            }
        }
        if (!this.prepend) return;
        const delta = Math.abs(scrollTop - this.prepend.scrollTop);
        if (delta > USER_SCROLL_TOLERANCE_PX) {
            this.prepend.invalidated = true;
        }
    }

    commitInitialPosition(
        scroll: ScrollAccessor,
        target: InitialPositionTarget,
        pages: NodeListOf<Element>,
        onWrite?: ProgrammaticScrollLogger,
    ): InitialPositionCommitResult {
        const tx = this.initialPosition ?? { scrollTop: scroll.getScrollTop(), invalidated: false };
        this.initialPosition = null;

        const scrollTop = scroll.getScrollTop();
        const scrollDelta = Math.abs(scrollTop - tx.scrollTop);
        const targetKind = target ? 'page' : 'top';
        if (tx.invalidated || scrollDelta > USER_SCROLL_TOLERANCE_PX) {
            return { action: 'cancelled', reason: 'user-scroll', delta: scrollDelta, target: targetKind };
        }

        const from = scrollTop;
        if (targetKind === 'page' && target) {
            const page = pages[target.pageIndex];
            if (!page) {
                const resetFrom = scroll.getScrollTop();
                scroll.setScrollTop(0);
                onWrite?.({ source: 'initial-fallback', from: resetFrom, to: scroll.getScrollTop() });
                return { action: 'fallback', reason: 'missing-page', pageIndex: target.pageIndex, from, to: scroll.getScrollTop() };
            }

            const scrollIntoViewFrom = scroll.getScrollTop();
            page.scrollIntoView({ block: 'start' });
            onWrite?.({ source: 'initial-restore-into-view', from: scrollIntoViewFrom, to: scroll.getScrollTop() });
            const offsetFrom = scroll.getScrollTop();
            scroll.setScrollTop(offsetFrom + target.scrollOffset);
            onWrite?.({ source: 'initial-restore-offset', from: offsetFrom, to: scroll.getScrollTop() });
            return {
                action: 'restored',
                target: 'page',
                pageIndex: target.pageIndex,
                scrollOffset: target.scrollOffset,
                from,
                to: scroll.getScrollTop(),
            };
        }

        const resetFrom = scroll.getScrollTop();
        scroll.setScrollTop(0);
        onWrite?.({ source: 'initial-reset', from: resetFrom, to: scroll.getScrollTop() });
        return { action: 'reset', target: 'top', from, to: scroll.getScrollTop() };
    }

    commitPrepend(scroll: ScrollAccessor, onWrite?: ProgrammaticScrollLogger): PrependCommitResult {
        const tx = this.prepend;
        this.prepend = null;

        if (!tx) return { action: 'none', reason: 'no-transaction' };
        if (!tx.anchor.isConnected) return { action: 'none', reason: 'anchor-detached' };

        const scrollTop = scroll.getScrollTop();
        const userDelta = scrollTop - tx.scrollTop;
        const targetTop = tx.anchorTop - userDelta;
        const anchorTop = tx.anchor.getBoundingClientRect().top;
        const diff = anchorTop - targetTop;
        if (Math.abs(diff) <= 1) return { action: 'none', reason: 'no-adjustment' };

        const from = scrollTop;
        scroll.setScrollTop(scrollTop + diff);
        onWrite?.({ source: 'prepend-adjust', from, to: scroll.getScrollTop() });
        return { action: 'adjusted', diff, userDelta, anchorTop, targetTop };
    }

    cancelPrepend(): void {
        this.prepend = null;
    }

    cancelInitialPosition(): void {
        this.initialPosition = null;
    }
}
