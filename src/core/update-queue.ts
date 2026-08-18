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

interface QueueItem {
    kind: string;
    steps: Step[];
    superseded: boolean;
}

const items = new Map<string, QueueItem>();
const DRAIN_DELAY_MS = 100;
let drainTimer: number | null = null;
let lastScrollAt = 0;
let listenersInstalled = false;

// Listeners are installed on FIRST ENQUEUE, never at module load: the first
// enqueue always happens after the takeover nuke (window.stop/document.open),
// and on iOS the nuke wipes listeners registered before it. The reader's
// scrollend listener works because it is registered post-nuke, inside open().
function ensureListeners(): void {
    if (listenersInstalled) return;
    listenersInstalled = true;
    window.addEventListener('scrollend', scheduleDrain);
    window.addEventListener('scroll', () => {
        lastScrollAt = Date.now();
    });
}

function scheduleDrain(): void {
    // Each trigger re-arms: the burst runs 100ms after the LAST one.
    if (drainTimer !== null) window.clearTimeout(drainTimer);
    drainTimer = window.setTimeout(() => {
        drainTimer = null;
        if (Date.now() - lastScrollAt < DRAIN_DELAY_MS) {
            // Scrolled very recently: postpone rather than interrupt.
            scheduleDrain();
            return;
        }
        drainNow();
    }, DRAIN_DELAY_MS);
}

function drainNow(): void {
    for (const kind of [...items.keys()]) {
        const item = items.get(kind);
        if (item === undefined) continue;
        items.delete(kind);
        if (item.superseded) continue;
        for (const step of item.steps) {
            if (item.superseded) break;
            step();
        }
    }
}

/**
 * Enqueue a batch of steps under a kind. A newer batch of the same kind
 * supersedes any pending batch (latest-wins).
 */
export function enqueue(kind: string, steps: Step[]): void {
    ensureListeners();
    const previous = items.get(kind);
    if (previous !== undefined) previous.superseded = true;
    items.set(kind, { kind, steps, superseded: false });
    // Arm now: an idle page drains without waiting for a scroll.
    scheduleDrain();
}

/** True while a batch of this kind is pending. */
export function isPending(kind: string): boolean {
    const item = items.get(kind);
    return item !== undefined && !item.superseded;
}

export function pendingKinds(): string[] {
    return [...items.keys()].filter(kind => {
        const item = items.get(kind);
        return item !== undefined && !item.superseded;
    });
}

/** Test seam: run the pending burst synchronously. */
export function runPendingDrain(): void {
    if (drainTimer !== null) {
        window.clearTimeout(drainTimer);
        drainTimer = null;
    }
    drainNow();
}

/** Test seam: reset all state. */
export function resetQueue(): void {
    items.clear();
    if (drainTimer !== null) {
        window.clearTimeout(drainTimer);
        drainTimer = null;
    }
    lastScrollAt = 0;
}
