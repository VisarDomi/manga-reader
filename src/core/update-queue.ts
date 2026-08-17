// Latest-wins coalescing update queue. Pending work is applied as ONE
// synchronous pass 100ms after the user stops scrolling (scrollend + 100ms) —
// the same cadence the reader uses for its own save work. Scrolling is never
// interrupted by update work; the pause after scrolling is the safe window
// for a synchronous burst.

type Step = () => void;

interface QueueItem {
    kind: string;
    steps: Step[];
    superseded: boolean;
}

const items = new Map<string, QueueItem>();
const DRAIN_DELAY_MS = 100;
let drainTimer: number | null = null;

if (typeof window !== 'undefined') {
    window.addEventListener('scrollend', scheduleDrain);
    window.addEventListener('pageshow', scheduleDrain);
    // Scrolling cancels any pending burst: the work defers to the scrollend
    // that follows, so a burst can never run mid-scroll.
    window.addEventListener('scroll', cancelPendingDrain);
}

function scheduleDrain(): void {
    // Each trigger re-arms: the burst runs 100ms after the LAST one.
    if (drainTimer !== null) window.clearTimeout(drainTimer);
    drainTimer = window.setTimeout(() => {
        drainTimer = null;
        drainNow();
    }, DRAIN_DELAY_MS);
}

function cancelPendingDrain(): void {
    if (drainTimer === null) return;
    window.clearTimeout(drainTimer);
    drainTimer = null;
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
 * supersedes any pending batch (latest-wins). The batch runs synchronously
 * at scrollend + 100ms.
 */
export function enqueue(kind: string, steps: Step[]): void {
    const previous = items.get(kind);
    if (previous !== undefined) previous.superseded = true;
    items.set(kind, { kind, steps, superseded: false });
    // The burst is armed by scrollend only — never by enqueue itself.
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
}
