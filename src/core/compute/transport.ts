import WorkerConstructor from './worker-entry?worker&inline';
import type { ComputeNotification, ComputeRequest, ComputeResponse, OpTypes } from './messages';

interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
}

interface WorkerState {
    worker: Worker;
    pending: Map<number, Pending>;
}

type NotifyHandler = (notification: ComputeNotification) => void;

let state: WorkerState | null = null;
let nextRequestId = 1;
let notifyHandler: NotifyHandler | null = null;

/** Register the handler for unsolicited worker notifications (cookie write-backs). */
export function onComputeNotification(handler: NotifyHandler): void {
    notifyHandler = handler;
}

function spawn(): WorkerState {
    const worker = new WorkerConstructor();
    const instance: WorkerState = { worker, pending: new Map() };
    worker.onmessage = (event: MessageEvent<ComputeResponse | ComputeNotification>) => {
        const message = event.data;
        if ((message as ComputeNotification).kind === 'notify') {
            notifyHandler?.(message as ComputeNotification);
            return;
        }
        const response = message as ComputeResponse;
        const entry = instance.pending.get(response.id);
        if (!entry) return;
        instance.pending.delete(response.id);
        if (response.ok) entry.resolve(response.value);
        else entry.reject(new Error(response.error ?? 'Compute worker rejected the request'));
    };
    worker.onerror = (event: ErrorEvent) => {
        // Only THIS instance's requests fail. A crash never poisons a newer
        // worker: the shared `state` pointer is dropped and the next request
        // spawns a fresh worker.
        const location = event.filename
            ? ` @ ${event.filename}:${event.lineno ?? 0}:${event.colno ?? 0}`
            : '';
        const error = new Error(
            `Compute worker crashed: ${event.message || '(no message)'}${location}`,
        );
        for (const entry of instance.pending.values()) entry.reject(error);
        if (state === instance) state = null;
    };
    return instance;
}

export function computeRequest<K extends keyof OpTypes>(
    op: K,
    payload?: OpTypes[K]['payload'],
): Promise<OpTypes[K]['result']> {
    const id = nextRequestId++;
    return new Promise((resolve, reject) => {
        let instance: WorkerState;
        try {
            instance = state ?? spawn();
            state = instance;
        } catch (error) {
            // e.g. CSP blocks the blob worker: new Worker() throws synchronously.
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
        }
        instance.pending.set(id, {
            resolve: resolve as (value: unknown) => void,
            reject,
        });
        const request: ComputeRequest = { id, op, payload };
        instance.worker.postMessage(request);
    });
}
