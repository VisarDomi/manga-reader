// Main-thread seam over the worker's history resolution. Tests replace this
// module (jsdom has no Worker); production routes through the compute worker.
import { computeRequest } from './transport';
import type { HistoryResolvePayload, OpTypes } from './messages';

export function resolveHistoryAsync(
    payload: HistoryResolvePayload,
): Promise<OpTypes['history-resolve']['result']> {
    return computeRequest('history-resolve', payload);
}
