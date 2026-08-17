// Latest-wins coalescing update queue, drained in small chunks so the main
// thread always yields between steps. No millisecond constants exist: chunks
// are bounded by a step COUNT, and the browser's event loop decides pacing.
//
// Scheduling: requestIdleCallback when available; otherwise a MessageChannel
// macrotask (WKWebView on iOS has no requestIdleCallback). Either way every
// drain applies at most MAX_STEPS_PER_DRAIN steps and then yields.
//
// BFCache semantics: while hidden, the page is frozen so drains simply wait;
// on restore they resume. Enqueueing is O(1) - the pageshow handler returns
// immediately.

type Step = () => void;

interface QueueItem {
    kind: string;
    steps: Step[];
    index: number;
    superseded: boolean;
}

const items = new Map<string, QueueItem>();
let running = false;

/** Steps applied per drain. A count cap, never a time budget. */
const MAX_STEPS_PER_DRAIN = 12;

type IdleCallback = (callback: () => void) => void;

const messageChannel = typeof MessageChannel !== 'undefined'
    ? new MessageChannel()
    : null;

function defaultSchedule(callback: () => void): void {
    if (typeof globalThis.requestIdleCallback === 'function') {
        globalThis.requestIdleCallback(callback);
        return;
    }
    if (messageChannel !== null) {
        messageChannel.port1.onmessage = () => callback();
        messageChannel.port2.postMessage(null);
        return;
    }
    // Every environment has setTimeout.
    globalThis.setTimeout(callback, 0);
}

let scheduleIdle: IdleCallback = defaultSchedule;

/** Test seam: install a deterministic scheduler. */
export function setIdleScheduler(scheduler: IdleCallback): void {
    scheduleIdle = scheduler;
}

/** Test seam: restore the production scheduler. */
export function resetIdleScheduler(): void {
    scheduleIdle = defaultSchedule;
}

function hasWork(): boolean {
    for (const item of items.values()) {
        if (!item.superseded && item.index < item.steps.length) return true;
    }
    return false;
}

function drain(): void {
    const kinds = [...items.keys()];
    let applied = 0;
    for (const kind of kinds) {
        if (applied >= MAX_STEPS_PER_DRAIN) break;
        const item = items.get(kind);
        if (item === undefined || item.superseded) {
            items.delete(kind);
            continue;
        }
        const deadline = getDeadline();
        while (
            item.index < item.steps.length &&
            applied < MAX_STEPS_PER_DRAIN &&
            hasTimeLeft(deadline)
        ) {
            if (item.superseded) {
                items.delete(kind);
                break;
            }
            item.steps[item.index]();
            item.index += 1;
            applied += 1;
        }
        if (item.index >= item.steps.length) items.delete(kind);
    }
    if (hasWork()) {
        scheduleIdle(drain);
    } else {
        running = false;
    }
}

// The real budget comes from the browser via IdleDeadline.timeRemaining()
// when requestIdleCallback exists. Behind a tiny indirection so tests can
// exercise the queue without a real IdleDeadline.
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
