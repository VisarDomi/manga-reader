import { installHomeBackup } from './pc-backup';
import { computeRequest } from './compute/transport';

export async function backupMangaHome(provider: string): Promise<void> {
    await installHomeBackup({
        app: 'manga-reader', provider,
        call: command => computeRequest('backup-control', command),
    })();
}
