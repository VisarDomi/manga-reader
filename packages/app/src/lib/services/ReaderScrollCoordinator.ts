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

    commitInitialPosition(
        root: HTMLElement,
        target: InitialPositionTarget,
        pages: NodeListOf<Element>,
        onWrite?: ProgrammaticScrollLogger,
    ): InitialPositionCommitResult {
        const tx = this.initialPosition ?? { scrollTop: root.scrollTop, invalidated: false };
        this.initialPosition = null;

        const scrollDelta = Math.abs(root.scrollTop - tx.scrollTop);
        const targetKind = target ? 'page' : 'top';
        if (tx.invalidated || scrollDelta > USER_SCROLL_TOLERANCE_PX) {
            return { action: 'cancelled', reason: 'user-scroll', delta: scrollDelta, target: targetKind };
        }

        const from = root.scrollTop;
        if (targetKind === 'page' && target) {
            const page = pages[target.pageIndex];
            if (!page) {
                const resetFrom = root.scrollTop;
                root.scrollTop = 0;
                onWrite?.({ source: 'initial-fallback', from: resetFrom, to: root.scrollTop });
                return { action: 'fallback', reason: 'missing-page', pageIndex: target.pageIndex, from, to: root.scrollTop };
            }

            const scrollIntoViewFrom = root.scrollTop;
            page.scrollIntoView({ block: 'start' });
            onWrite?.({ source: 'initial-restore-into-view', from: scrollIntoViewFrom, to: root.scrollTop });
            const offsetFrom = root.scrollTop;
            root.scrollTop += target.scrollOffset;
            onWrite?.({ source: 'initial-restore-offset', from: offsetFrom, to: root.scrollTop });
            return {
                action: 'restored',
                target: 'page',
                pageIndex: target.pageIndex,
                scrollOffset: target.scrollOffset,
                from,
                to: root.scrollTop,
            };
        }

        const resetFrom = root.scrollTop;
        root.scrollTop = 0;
        onWrite?.({ source: 'initial-reset', from: resetFrom, to: root.scrollTop });
        return { action: 'reset', target: 'top', from, to: root.scrollTop };
    }

    commitPrepend(root: HTMLElement, onWrite?: ProgrammaticScrollLogger): PrependCommitResult {
        const tx = this.prepend;
        this.prepend = null;

        if (!tx) return { action: 'none', reason: 'no-transaction' };
        if (!tx.anchor.isConnected) return { action: 'none', reason: 'anchor-detached' };

        const userDelta = root.scrollTop - tx.scrollTop;
        const targetTop = tx.anchorTop - userDelta;
        const anchorTop = tx.anchor.getBoundingClientRect().top;
        const diff = anchorTop - targetTop;
        if (Math.abs(diff) <= 1) return { action: 'none', reason: 'no-adjustment' };

        const from = root.scrollTop;
        root.scrollTop += diff;
        onWrite?.({ source: 'prepend-adjust', from, to: root.scrollTop });
        return { action: 'adjusted', diff, userDelta, anchorTop, targetTop };
    }

    cancelPrepend(): void {
        this.prepend = null;
    }

    cancelInitialPosition(): void {
        this.initialPosition = null;
    }
}
