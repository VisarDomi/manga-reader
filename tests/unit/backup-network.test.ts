import { afterEach, expect, it, vi } from 'vitest';
import { backupControl, type BackupData } from '../../src/core/backup-engine';

const adapter: BackupData = {
    capture: async () => { throw new Error('Unexpected capture'); },
    restore: async () => { throw new Error('Unexpected restore'); },
    stats: () => 'fixture',
};
function listing(fetcher: typeof fetch) {
    vi.stubGlobal('__READER_BACKUP_URL__', 'https://pc.test');
    vi.stubGlobal('__READER_BACKUP_KEY__', 'fixture-key');
    vi.stubGlobal('fetch', fetcher);
    return backupControl({ action: 'fetch-list', scope: 'gallery-reader:hitomi' }, adapter);
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('an unreachable PC returns unavailable, not an empty backup list', async () => {
    await expect(listing(async () => { throw new TypeError('Failed to fetch'); })).resolves.toBeNull();
});
it('a stalled PC request aborts and quietly becomes unavailable', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const pending = listing((_url, options) => new Promise((_resolve, reject) => {
        signal = options?.signal;
        signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const result = expect(pending).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(8000);
    await result;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
});
it('a connection lost while reading the response is unavailable', async () => {
    const response = new Response('[]');
    vi.spyOn(response, 'text').mockRejectedValue(new TypeError('Connection lost'));
    await expect(listing(async () => response)).resolves.toBeNull();
});
it.each([500, 502, 503, 504])('HTTP %s is quiet service unavailability', async status => {
    await expect(listing(async () => new Response('', { status }))).resolves.toBeNull();
});
it('an online empty server returns an actual empty list, allowing first-time setup', async () => {
    await expect(listing(async () => new Response('[]'))).resolves.toEqual([]);
});
it('online authentication and malformed-data errors are not hidden as offline', async () => {
    await expect(listing(async () => new Response('', { status: 401 }))).rejects.toThrow('HTTP 401');
    await expect(listing(async () => new Response('not JSON'))).rejects.toThrow();
});
