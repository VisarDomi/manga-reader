// The shared worker owns ordering, progress rules, validation and backup format.
// This adapter changes only the durable storage boundary from IDB to atomic files.
import type { ChapterProgress } from '../../../src/core/compute/progress';
import { validateDatabaseBackup, emptyDatabaseBackup, type DatabaseBackup } from '../../../src/core/compute/backup';
import { host } from './worker-bridge';
async function read(): Promise<DatabaseBackup> { return validateDatabaseBackup(await host('read',{key:'database'}) ?? emptyDatabaseBackup()); }
async function write(data: DatabaseBackup): Promise<void> {
    await host('write',{key:'database',value:data});
    self.postMessage({progressChanged:true,progress:data.indexedDB.progress});
}
export async function progressSnapshot(metadataKey: string) {
    const data = await read();
    return {entries:data.indexedDB.progress,metadata:data.indexedDB.metadata.find(row=>row.key===metadataKey)?.value};
}
export async function replaceProgress(entries: ChapterProgress[], metadataKey: string, metadataValue: unknown) {
    const data = await read(); data.indexedDB.progress = entries;
    data.indexedDB.metadata = data.indexedDB.metadata.filter(row=>row.key!==metadataKey);
    data.indexedDB.metadata.push({key:metadataKey,value:metadataValue}); await write(data);
}
export async function progressPut(entry: ChapterProgress) {
    const data = await read();
    data.indexedDB.progress = data.indexedDB.progress.filter(row=>row.id!==entry.id);
    data.indexedDB.progress.push(entry); await write(data);
}
export const databaseBackup = read;
export async function restoreDatabaseBackup(raw: unknown) { await write(validateDatabaseBackup(raw)); }
