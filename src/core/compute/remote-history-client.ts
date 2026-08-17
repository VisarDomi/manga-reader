// Main-thread seam over the worker's authenticated remote-history fetch.
// Tests replace this module (jsdom has no Worker); production routes through
// the compute worker.
import { computeRequest } from './transport';
import type { OpTypes, RemoteHistoryPayload } from './messages';

export function fetchRemoteHistoryAsync(
    payload: RemoteHistoryPayload,
): Promise<OpTypes['remote-history']['result']> {
    return computeRequest('remote-history', payload);
}
