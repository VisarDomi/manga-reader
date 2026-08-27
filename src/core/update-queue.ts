// Latest-wins coalescing update queue.
//
// Work is applied as ONE synchronous pass 100ms after the page goes quiet:
// - enqueue and scrollend arm the 100ms timer;
// - when the timer fires, a scroll event in the last 100ms postpones it
//   (re-arm) instead of interrupting scrolling.
//
// Result: an idle page drains its first batch 100ms after it is enqueued,
// and a scrolling page drains 100ms after its last scrollend — the same
// cadence the reader uses for its own save work. The quiet re-check keeps
// the burst from ever landing mid-scroll while the re-arm guarantees it
// converges (an endless stream of scroll events only delays it).

type Step = () => void;

const DRAIN_DELAY_MS = 100;

export enum UpdateKind {
    History,
    Catalog,
}

export class UpdateQueue {
    private readonly items = new Map<UpdateKind, Step[]>();
    private drainTimer: number | null = null;
    private lastScrollAt = 0;
    private listenersInstalled = false;

    private readonly recordScroll = (): void => {
        this.lastScrollAt = Date.now();
    };

    private readonly scheduleDrain = (): void => {
        // Each trigger re-arms: the burst runs 100ms after the LAST one.
        if (this.drainTimer !== null) window.clearTimeout(this.drainTimer);
        this.drainTimer = window.setTimeout(() => {
            this.drainTimer = null;
            if (Date.now() - this.lastScrollAt < DRAIN_DELAY_MS) {
                // Scrolled very recently: postpone rather than interrupt.
                this.scheduleDrain();
                return;
            }
            this.drainNow();
        }, DRAIN_DELAY_MS);
    };

    // Installed on first enqueue, after the takeover nuke. Once the queue is
    // empty they are released; a later enqueue installs them again.
    private ensureListeners(): void {
        if (this.listenersInstalled) return;
        this.listenersInstalled = true;
        window.addEventListener('scrollend', this.scheduleDrain);
        window.addEventListener('scroll', this.recordScroll);
    }

    private releaseListeners(): void {
        if (!this.listenersInstalled) return;
        window.removeEventListener('scrollend', this.scheduleDrain);
        window.removeEventListener('scroll', this.recordScroll);
        this.listenersInstalled = false;
    }

    private drainNow(): void {
        for (const kind of [...this.items.keys()]) {
            const steps = this.items.get(kind);
            if (steps === undefined) continue;
            this.items.delete(kind);
            for (const step of steps) step();
        }
        if (this.items.size === 0) this.releaseListeners();
    }

    /** A newer pending batch of the same kind replaces the previous batch. */
    enqueue(kind: UpdateKind, steps: Step[]): void {
        this.ensureListeners();
        this.items.set(kind, steps);
        // Arm now: an idle page drains without waiting for a scroll.
        this.scheduleDrain();
    }
}
