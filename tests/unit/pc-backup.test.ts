// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { backupHome, type BackupAdapter } from '../../src/core/pc-backup';

let phone: { version: number; ids: number[] };
let identity: { id: string; label: string; revision: string | null } | null;
let requests: Array<{ method: string; url: string; data?: string }>;
let remote: Array<{ id: string; label: string; current: { data: typeof phone }; previous: { data: typeof phone } | null }>;
let failGet: boolean;
let losePutAck: boolean;
let rejectSave: boolean;
let saveWait: Promise<void> | undefined;
// This simulates the RPC boundary; production parsing and database access run in the worker.
const adapter: BackupAdapter = {
    app: 'gallery-reader', provider: 'hitomi',
    async call(command) {
        switch (command.action) {
            case 'state': return { identity, stats: phone.ids.length + ' favorites' };
            case 'fetch-list': {
                requests.push({ method: 'GET', url: '/backups' });
                if (failGet) return null;
                return remote.flatMap(backup => ['current', 'previous'].flatMap(generation => {
                const snapshot = backup[generation as 'current' | 'previous'];
                return snapshot ? [{ selection: backup.id + ':' + generation, label: backup.label + ' ' + generation, stats: snapshot.data.ids.length + ' favorites' }] : [];
            }));
            }
            case 'choose': {
                if (command.selection) {
                    const [id, generation] = command.selection.split(':');
                    phone = remote.find(backup => backup.id === id)![generation as 'current' | 'previous']!.data;
                }
                identity = { id: crypto.randomUUID(), label: command.label!, revision: null };
                return { restored: Boolean(command.selection) };
            }
            case 'save': {
                const data = JSON.stringify({ label: identity!.label, baseRevision: identity!.revision, data: phone });
                requests.push({ method: 'PUT', url: '/backups/' + identity!.id, data });
                await saveWait;
                if (losePutAck) return null;
                if (rejectSave) throw new Error('PC backup HTTP 403');
                identity!.revision = 'saved-revision';
                return { label: identity!.label, stats: phone.ids.length + ' favorites' };
            }
            default: throw new Error('Unexpected command');
        }
    },
};
function controls(): ShadowRoot { return document.querySelector('#reader-backup-setup')!.shadowRoot!; }
function click(text: string): void { [...controls().querySelectorAll('button')].find(button => button.textContent === text)!.click(); }
beforeEach(() => {
    document.querySelectorAll('#reader-backup-setup, #reader-backup-status').forEach(node => node.remove());
    phone = { version: 1, ids: [1, 2] };
    identity = null; requests = []; remote = []; failGet = false; losePutAck = false; rejectSave = false; saveWait = undefined;
});
it('new phone uploads nothing before its choice, and UI never reads browser storage', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem');
    const put = vi.spyOn(Storage.prototype, 'setItem');
    const task = backupHome(adapter);
    await vi.waitFor(() => expect(document.querySelector('#reader-backup-setup')).not.toBeNull());
    expect(requests.map(r => r.method)).toEqual(['GET']);
    expect(controls().textContent).toContain('2 favorites');
    click('Back up this phone');
    expect(await task).toBe(true);
    expect(identity!.revision).toBe('saved-revision');
    expect(document.querySelector('#reader-backup-status')!.textContent).toContain('Backed up to PC');
    expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
    vi.restoreAllMocks();
});
it('restore selects previous snapshot and always uploads into a new identity', async () => {
    remote = [{ id: 'old-phone', label: 'Before format', current: { data: { version: 1, ids: [4] } }, previous: { data: { version: 1, ids: [4, 5] } } }];
    phone = { version: 1, ids: [] };
    const task = backupHome(adapter);
    await vi.waitFor(() => expect(document.querySelector('#reader-backup-setup')).not.toBeNull());
    const select = controls().querySelector('select')!;
    select.value = 'old-phone:previous'; select.dispatchEvent(new Event('change'));
    expect(controls().textContent).toContain('On PC: 2 favorites');
    click('Restore from PC');
    expect(await task).toBe(true);
    expect(phone).toEqual(remote[0].previous!.data);
    expect(document.querySelector('#reader-backup-status')!.textContent).toContain('Backed up to PC');
    expect(requests[1].url).not.toContain('old-phone');
    expect(JSON.parse(requests[1].data!).baseRevision).toBeNull();
    expect(remote[0].current.data.ids).toEqual([4]);
});
it('routine home visits save changed data silently, including while the PC is waiting', async () => {
    identity = { id: 'phone-id', label: 'Phone', revision: 'old-revision' };
    let finish!: () => void;
    saveWait = new Promise(resolve => { finish = resolve; });
    const pending = backupHome(adapter);
    expect(document.querySelector('#reader-backup-status')).toBeNull();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(document.querySelector('#reader-backup-status')).toBeNull();
    finish();
    expect(await pending).toBe(true);
    expect(requests.map(r => r.method)).toEqual(['PUT']);
    expect(JSON.parse(requests[0].data!).baseRevision).toBe('old-revision');
    expect(document.querySelector('#reader-backup-setup')).toBeNull();
    expect(document.querySelector('#reader-backup-status')).toBeNull();
    phone.ids.push(3);
    expect(await backupHome(adapter)).toBe(true);
    expect(JSON.parse(requests[1].data!).data.ids).toEqual([1, 2, 3]);
    expect(document.querySelector('#reader-backup-status')).toBeNull();
});
it('an online server rejecting access stays visible, then successful retry clears it silently', async () => {
    identity = { id: 'phone-id', label: 'Phone', revision: 'old-revision' };
    rejectSave = true;
    expect(await backupHome(adapter)).toBe(false);
    expect(document.querySelector('#reader-backup-status')!.textContent).toContain('NOT completed');
    rejectSave = false;
    expect(await backupHome(adapter)).toBe(true);
    expect(document.querySelector('#reader-backup-status')).toBeNull();
});
it('unreachable PC leaves a new phone unenrolled with no prompt or notification', async () => {
    failGet = true;
    expect(await backupHome(adapter)).toBe(false);
    expect(identity).toBeNull();
    expect(requests.map(r => r.method)).toEqual(['GET']);
    expect(document.querySelector('#reader-backup-status')).toBeNull();
    expect(document.querySelector('#reader-backup-setup')).toBeNull();
});
it('unreachable PC preserves an enrolled phone and later backs it up silently', async () => {
    identity = { id: 'phone-id', label: 'Phone', revision: 'old-revision' };
    losePutAck = true;
    expect(await backupHome(adapter)).toBe(false);
    expect(identity.revision).toBe('old-revision');
    expect(document.querySelector('#reader-backup-status')).toBeNull();
    expect(document.querySelector('#reader-backup-setup')).toBeNull();
    losePutAck = false;
    expect(await backupHome(adapter)).toBe(true);
    expect(identity.id).toBe('phone-id');
    expect(document.querySelector('#reader-backup-status')).toBeNull();
});
it('Later neither enrolls nor uploads', async () => {
    const task = backupHome(adapter);
    await vi.waitFor(() => expect(document.querySelector('#reader-backup-setup')).not.toBeNull());
    click('Later'); expect(await task).toBe(false);
    expect(identity).toBeNull(); expect(requests).toHaveLength(1);
    expect(document.querySelector('#reader-backup-status')).toBeNull();
});
it('lost acknowledgement retries the same persisted ID', async () => {
    losePutAck = true;
    const task = backupHome(adapter);
    await vi.waitFor(() => expect(document.querySelector('#reader-backup-setup')).not.toBeNull());
    click('Back up this phone'); expect(await task).toBe(false);
    expect(document.querySelector('#reader-backup-status')).toBeNull();
    const id = identity!.id; expect(identity!.revision).toBeNull();
    losePutAck = false; expect(await backupHome(adapter)).toBe(true);
    expect(requests[1].url).toBe(requests[2].url); expect(identity!.id).toBe(id);
    expect(document.querySelector('#reader-backup-status')!.textContent).toContain('Backed up to PC');
});
