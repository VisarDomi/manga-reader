// UI only. Network, storage, snapshot processing and identity live in the worker.
import type { BackupCommand } from './backup-engine';
export interface BackupAdapter {
    app: string;
    provider: string;
    call(command: BackupCommand): Promise<unknown>;
}
interface BackupOption { selection: string; label: string; stats: string }
export const backupIdentityKey = (app: string, provider: string): string => app + ':' + provider;

function report(message: string, failed = false): void {
    document.querySelector('#reader-backup-status')?.remove();
    const element = document.createElement('div');
    element.id = 'reader-backup-status';
    element.setAttribute('role', 'status');
    element.style.cssText = 'position:fixed;bottom:10px;left:10px;right:10px;z-index:2147483647;padding:12px;background:#222;color:white;font:14px system-ui;border:1px solid #777;white-space:pre-wrap';
    element.textContent = message + ' (tap to dismiss)';
    element.onclick = () => element.remove();
    document.documentElement.append(element);
    if (!failed) window.setTimeout(() => element.remove(), 12000);
}


async function choose(adapter: BackupAdapter, localStats: string, options: BackupOption[]): Promise<{ label: string; selection?: string } | null> {
    return new Promise(resolve => {
        const host = document.createElement('div');
        host.id = 'reader-backup-setup';
        host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#000b;display:grid;place-items:center';
        const shadow = host.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = ':host{color:white;font:16px system-ui}section{background:#222;padding:20px;margin:12px;max-width:480px;max-height:85vh;overflow:auto;border:1px solid #777;border-radius:8px}button,input,select{font:inherit;padding:10px;box-sizing:border-box;margin:6px 0;max-width:100%}input,select{width:100%}button{cursor:pointer}p{white-space:pre-wrap;line-height:1.4}';
        const box = document.createElement('section');
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');
        box.setAttribute('aria-label', 'Reader backup setup');
        const title = document.createElement('h2');
        title.textContent = adapter.app + ' · ' + adapter.provider;
        const phone = document.createElement('p');
        phone.textContent = 'On this phone: ' + localStats;
        const name = document.createElement('input');
        name.placeholder = 'Backup name (e.g. My iPhone)';
        name.setAttribute('aria-label', 'New backup name');
        name.maxLength = 80;
        name.value = 'iPhone';
        const save = document.createElement('button');
        save.textContent = 'Back up this phone';
        const selector = document.createElement('select');
        selector.setAttribute('aria-label', 'PC backup to restore');
        for (const option of options) selector.add(new Option(option.label, option.selection));
        const remote = document.createElement('p');
        function update(): void {
            remote.textContent = options.length ? 'On PC: ' + options.find(option => option.selection === selector.value)!.stats : 'No backup for this provider on the PC yet.';
        }
        selector.onchange = update;
        update();
        const restore = document.createElement('button');
        restore.textContent = 'Restore from PC';
        restore.disabled = options.length === 0;
        const note = document.createElement('p');
        note.textContent = 'Restore replaces this provider’s local reader data. It creates a new independent backup; the original stays intact.';
        const later = document.createElement('button');
        later.textContent = 'Later';
        const finish = (selection?: string): void => {
            const label = name.value.trim();
            if (!label) { name.focus(); return; }
            host.remove();
            resolve({ label, selection });
        };
        save.onclick = () => finish();
        restore.onclick = () => finish(selector.value);
        later.onclick = () => { host.remove(); resolve(null); };
        box.append(title, phone, name, save, selector, remote, restore, note, later);
        shadow.append(style, box);
        document.documentElement.append(host);
    });
}


/** Runs after local content paints. No IndexedDB, localStorage, or JSON work on this thread. */
export async function backupHome(adapter: BackupAdapter): Promise<boolean> {
    const scope = backupIdentityKey(adapter.app, adapter.provider);
    const call = (action: string, fields: Partial<BackupCommand> = {}) => adapter.call({ action, scope, ...fields });
    try {
        const state = await call('state') as { identity: { revision: string | null } | null; stats: string };
        // Only initial setup (including an interrupted first upload) needs confirmation.
        const confirmSetup = !state.identity?.revision;
        if (!state.identity) {
            const options = await call('fetch-list') as BackupOption[] | null;
            if (options === null) return false;
            const choice = await choose(adapter, state.stats, options);
            if (!choice) return false;
            const result = await call('choose', choice) as { restored: boolean };
            if (result.restored) window.dispatchEvent(new Event('reader-data-restored'));
        }
        const upload = await call('save') as { label: string; stats: string } | null;
        if (upload === null) return false;
        if (confirmSetup) report('Backed up to PC: ' + upload.label + ' · ' + adapter.provider + '\n' + upload.stats);
        else document.querySelector('#reader-backup-status')?.remove(); // Clear a recovered failure without another toast.
        return true;
    } catch (error) {
        report('PC backup NOT completed: ' + (error instanceof Error ? error.message : String(error)) + '\nKeep the phone’s data. Revisit home to retry.', true);
        return false;
    }
}
export function installHomeBackup(adapter: BackupAdapter, afterBackup?: () => void): () => Promise<void> {
    let running = false;
    const run = async (): Promise<void> => {
        if (running) return;
        running = true;
        try {
            const task = async (): Promise<void> => { if (await backupHome(adapter)) afterBackup?.(); };
            if (navigator.locks) await navigator.locks.request(backupIdentityKey(adapter.app, adapter.provider), task);
            else await task();
        } finally { running = false; }
    };
    window.addEventListener('pageshow', event => { if (event.persisted) void run(); });
    return run;
}
