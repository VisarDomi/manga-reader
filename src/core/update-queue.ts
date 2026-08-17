// Latest-wins coalescing update queue, drained one step at a time inside
// requestIdleCallback. The main thread applies already-computed models here;
// the browser decides the time budget, so no millisecond constants exist.
//
// BFCache semantics: while hidden, idle callbacks never fire, so updates simply
// wait; on restore they resume when the page is next idle. Enqueueing is O(1) —
// the pageshow handler returns immediately.

type Step = () => void;

interface QueueItem {
    kind: string;
    steps: Step[];
    index: number;
    superseded: boolean;
}

const items = new Map<string, QueueItem>();
let running = false;

type IdleCallback = (callback: () => void) => void;

let scheduleIdle: IdleCallback = callback => {
    // requestIdleCallback exists on all supported targets (iOS 26+, modern
    // Chrome/Firefox). Tests inject a synchronous scheduler instead.
    if (typeof globalThis.requestIdleCallback !== 'function') {
        throw new Error('requestIdleCallback is unavailable');
    }
    globalThis.requestIdleCallback(callback);
};

/** Test seam: jsdom has no requestIdleCallback. */
export function setIdleScheduler(scheduler: IdleCallback): void {
    scheduleIdle = scheduler;
}

function hasWork(): boolean {
    for (const item of items.values()) {
        if (!item.superseded && item.index < item.steps.length) return true;
    }
    return false;
}

function drain(): void {
    // Snapshot kinds so enqueue during apply cannot disturb this pass.
    const kinds = [...items.keys()];
    for (const kind of kinds) {
        const item = items.get(kind);
        if (item === undefined || item.superseded) {
            items.delete(kind);
            continue;
        }
        const deadline = getDeadline();
        while (item.index < item.steps.length) {
            if (item.superseded) {
                items.delete(kind);
                break;
            }
            if (!hasTimeLeft(deadline)) break;
            item.steps[item.index]();
            item.index += 1;
        }
        if (item.index >= item.steps.length) items.delete(kind);
    }
    if (hasWork()) {
        scheduleIdle(drain);
    } else {
        running = false;
    }
}

// The real budget comes from the browser via IdleDeadline.timeRemaining().
// Keeping it behind two tiny indirections so tests can exercise the queue
// without a real IdleDeadline.
let deadlineSource: () => { timeRemaining(): number } | null = () => {
    const deadline = (globalThis as { __idleDeadline?: { timeRemaining(): number } }).__idleDeadline;
    return deadline ?? null;
};
const getDeadline = () => deadlineSource();
const hasTimeLeft = (deadline: { timeRemaining(): number } | null): boolean =>
    deadline === null || deadline.timeRemaining() > 0;

/** Test seam: provide an IdleDeadline-shaped budget for the next drain. */
export function setIdleDeadlineSource(source: () => { timeRemaining(): number } | null): void {
    deadlineSource = source;
}

/**
 * Enqueue a batch of steps under a kind. A newer batch of the same kind
 * supersedes any pending or partially applied batch (latest-wins).
 */
export function enqueue(kind: string, steps: Step[]): void {
    const previous = items.get(kind);
    if (previous !== undefined) previous.superseded = true;
    items.set(kind, { kind, steps, index: 0, superseded: false });
    if (!running) {
        running = true;
        scheduleIdle(drain);
    }
}

/** True while a batch of this kind is pending or partially applied. */
export function isPending(kind: string): boolean {
    const item = items.get(kind);
    return item !== undefined && !item.superseded && item.index < item.steps.length;
}

export function pendingKinds(): string[] {
    return [...items.entries()]
        .filter(([, item]) => !item.superseded && item.index < item.steps.length)
        .map(([kind]) => kind);
}

/** Test seam: reset all state. */
export function resetQueue(): void {
    items.clear();
    running = false;
}
