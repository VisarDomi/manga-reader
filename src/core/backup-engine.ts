// Worker-only backup coordination. UI sees summaries, never database snapshots.
export interface BackupData {
    capture(): Promise<unknown>;
    restore(data: unknown): Promise<void>;
    stats(data: unknown): string;
}
interface Identity { id: string; label: string; revision: string | null }
interface Snapshot { revision: string; savedAt: string; data: unknown }
interface Backup { id: string; label: string; current: Snapshot; previous: Snapshot | null }
export interface BackupCommand { action: string; scope: string; label?: string; selection?: string; text?: string }
let dbPromise: Promise<IDBDatabase> | undefined;
function database(): Promise<IDBDatabase> {
    return dbPromise ??= new Promise((resolve, reject) => {
        const request = indexedDB.open('reader-pc-backup-state-v1', 1);
        const timer = setTimeout(() => reject(new Error('Backup database open timed out')), 10000);
        request.onupgradeneeded = () => request.result.createObjectStore('identities');
        request.onsuccess = () => {
            clearTimeout(timer);
            const db = request.result;
            db.onversionchange = () => { db.close(); dbPromise = undefined; };
            resolve(db);
        };
        request.onerror = () => { clearTimeout(timer); dbPromise = undefined; reject(request.error); };
        request.onblocked = () => { clearTimeout(timer); dbPromise = undefined; reject(new Error('Backup database blocked by another tab')); };
    });
}
async function identity(scope: string, value?: Identity | null): Promise<Identity | null> {
    const db = await database();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('identities', value === undefined ? 'readonly' : 'readwrite', { durability: 'strict' });
        const store = tx.objectStore('identities');
        let result: Identity | null = value ?? null;
        const timer = setTimeout(() => { tx.abort(); reject(new Error('Backup identity transaction timed out')); }, 10000);
        if (value === undefined) {
            const request = store.get(scope);
            request.onsuccess = () => { result = request.result ?? null; };
        } else if (value === null) store.delete(scope);
        else store.put(value, scope);
        tx.oncomplete = () => { clearTimeout(timer); resolve(result); };
        tx.onabort = tx.onerror = () => { clearTimeout(timer); reject(tx.error ?? new Error('Backup identity transaction failed')); };
    });
}
const candidates = new Map<string, Map<string, Snapshot>>();
// null means the PC is unavailable; it must not trigger setup, acknowledgement, or UI.
async function pcRequest(scope: string, method: string, body?: string, id?: string): Promise<string | null> {
    const base = typeof __READER_BACKUP_URL__ === 'string' ? __READER_BACKUP_URL__.replace(/\/$/, '') : '';
    const key = typeof __READER_BACKUP_KEY__ === 'string' ? __READER_BACKUP_KEY__ : '';
    if (!base || !key) throw new Error('Backup server/key missing; rebuild the userscript');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        let response: Response;
        try {
            response = await fetch(base + '/api/reader-backups/' + scope.replace(':', '/') + (id ? '/' + id : ''), {
                method, headers: { 'Content-Type': 'application/json', 'X-Reader-Backup-Key': key }, body, signal: controller.signal,
            });
        } catch { return null; } // Offline, refused connection, DNS/TLS/CORS failure, or timeout.
        if (response.status >= 500) return null;
        if (!response.ok) {
            if (response.status === 409) await identity(scope, null);
            throw new Error('PC backup HTTP ' + response.status + (response.status === 409 ? ': revisit home to choose Backup or Restore' : ''));
        }
        try { return await response.text(); } catch { return null; } // Connection lost mid-response.
    } finally { clearTimeout(timer); }
}
export async function backupControl(command: BackupCommand, adapter: BackupData): Promise<unknown> {
    const { action, scope } = command;
    if (action === 'fetch-list') {
        const text = await pcRequest(scope, 'GET');
        return text === null ? null : backupControl({ action: 'list', scope, text }, adapter);
    }
    if (action === 'save') {
        const upload = await backupControl({ action: 'upload', scope }, adapter) as { id: string; label: string; stats: string; text: string };
        const text = await pcRequest(scope, 'PUT', upload.text, upload.id);
        if (text === null) return null;
        await backupControl({ action: 'ack', scope, text }, adapter);
        return { label: upload.label, stats: upload.stats };
    }
    if (action === 'state') {
        const current = await identity(scope);
        return { identity: current, stats: adapter.stats(await adapter.capture()) };
    }
    if (action === 'enrolled') return Boolean((await identity(scope))?.revision);
    if (action === 'reset') { await identity(scope, null); return; }
    if (action === 'list') {
        const backups = JSON.parse(command.text!) as Backup[];
        if (!Array.isArray(backups)) throw new Error('Invalid backup listing');
        const choices = new Map<string, Snapshot>();
        const rows: Array<{ selection: string; label: string; stats: string }> = [];
        for (const backup of backups) for (const generation of ['current', 'previous'] as const) {
            const snapshot = backup[generation];
            if (!snapshot) continue;
            const selection = backup.id + ':' + generation;
            const stats = adapter.stats(snapshot.data); // validate before offering restore
            choices.set(selection, snapshot);
            rows.push({ selection, label: backup.label + ' · ' + backup.id.slice(0, 8) + ' · ' + generation + ' · ' + new Date(snapshot.savedAt).toLocaleString(), stats });
        }
        candidates.set(scope, choices);
        return rows;
    }
    if (action === 'choose') {
        if (!command.label?.trim()) throw new Error('Backup name required');
        if (command.selection) {
            const selected = candidates.get(scope)?.get(command.selection);
            if (!selected) throw new Error('Backup selection expired; revisit home');
            await adapter.restore(selected.data);
        }
        // Save intent before upload: lost HTTP acknowledgements reuse the same ID.
        const created = { id: crypto.randomUUID(), label: command.label.trim(), revision: null };
        await identity(scope, created);
        candidates.delete(scope);
        return { restored: Boolean(command.selection) };
    }
    if (action === 'upload') {
        const current = await identity(scope);
        if (!current) throw new Error('Choose Backup or Restore first');
        const data = await adapter.capture();
        const stats = adapter.stats(data);
        return { id: current.id, label: current.label, stats, text: JSON.stringify({ label: current.label, baseRevision: current.revision, data }) };
    }
    if (action === 'ack') {
        const saved = JSON.parse(command.text!) as Backup;
        const current = await identity(scope);
        if (!current || saved.id !== current.id || typeof saved.current?.revision !== 'string') throw new Error('Unexpected backup acknowledgement');
        current.revision = saved.current.revision;
        await identity(scope, current);
        return;
    }
    throw new Error('Unknown backup operation: ' + action);
}
