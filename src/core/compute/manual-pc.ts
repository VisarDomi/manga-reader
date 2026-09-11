// Explicit commands only. Availability never reads or writes a reading snapshot.
import { databaseBackup, restoreDatabaseBackup } from './store';
import { loadProgress } from './migrations';
import { validateDatabaseBackup } from './backup';
export interface PCCommand { action: 'available' | 'load' | 'save'; provider: string }
export async function manualPC({ action, provider }: PCCommand): Promise<boolean> {
    if (!/^[a-z]+$/.test(provider)) throw new Error('Invalid provider');
    const base = typeof __READER_BACKUP_URL__ === 'string' ? __READER_BACKUP_URL__.replace(/\/$/, '') : '';
    const key = typeof __READER_BACKUP_KEY__ === 'string' ? __READER_BACKUP_KEY__ : '';
    if (!base || !key) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        let body: string | undefined;
        if (action === 'save') {
            await loadProgress();
            const snapshot = await databaseBackup();
            snapshot.indexedDB.progress = snapshot.indexedDB.progress.filter(p => p.provider === provider);
            body = JSON.stringify(snapshot);
        }
        const response = await fetch(`${base}/api/reader-backups/manual/manga-reader/${provider}${action === 'available' ? '/status' : ''}`, {
            method: action === 'save' ? 'PUT' : 'GET',
            headers: { 'Content-Type': 'application/json', 'X-Reader-Backup-Key': key }, body, signal: controller.signal,
        });
        if (!response.ok) {
            if (action === 'available') return false;
            if (response.status === 404) throw new Error('No saved reading state on PC');
            throw new Error('PC request failed');
        }
        if (action === 'load') {
            const incoming = validateDatabaseBackup(await response.json());
            if (incoming.indexedDB.progress.some(p => p.provider !== provider)) throw new Error('Wrong provider in PC state');
            await loadProgress();
            const local = await databaseBackup();
            // Only this provider's reading state is replaced. Sessions stay local.
            incoming.indexedDB.progress.push(...local.indexedDB.progress.filter(p => p.provider !== provider));
            incoming.indexedDB.tokens = local.indexedDB.tokens;
            await restoreDatabaseBackup(incoming);
        }
        return true;
    } catch (error) {
        if (action === 'available') return false;
        throw error;
    } finally { clearTimeout(timer); }
}
