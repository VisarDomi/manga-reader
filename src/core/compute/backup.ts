import { createChapterProgress, type ChapterProgress } from './progress';

export interface DatabaseBackup {
    version: 1;
    indexedDB: {
        progress: ChapterProgress[];
        tokens: Array<{ key: string; value: unknown }>;
        metadata: Array<{ key: string; value: unknown }>;
    };
}

export function validateDatabaseBackup(data: unknown): DatabaseBackup {
    const snapshot = data as DatabaseBackup;
    if (snapshot?.version !== 1 || !snapshot.indexedDB) throw new Error('Invalid manga backup');
    const stores = snapshot.indexedDB;
    for (const name of ['progress', 'tokens', 'metadata'] as const) {
        if (!Array.isArray(stores[name])) throw new Error('Missing backup store: ' + name);
    }
    const ids = new Set<string>();
    for (const entry of stores.progress) {
        if (!entry || typeof entry.provider !== 'string' || typeof entry.seriesSlug !== 'string' || typeof entry.chapterId !== 'string' || !Number.isFinite(entry.updatedAt)) throw new Error('Invalid resume position');
        const valid = createChapterProgress(entry.provider, entry.seriesSlug, entry.chapterId, entry.imageIndex, entry.totalImages, entry.updatedAt);
        if (valid.id !== entry.id || ids.has(entry.id)) throw new Error('Invalid or duplicate progress identity');
        ids.add(entry.id);
    }
    for (const name of ['tokens', 'metadata'] as const) {
        const keys = new Set<string>();
        for (const entry of stores[name]) {
            if (!entry || typeof entry.key !== 'string' || keys.has(entry.key) || !Object.hasOwn(entry, 'value')) throw new Error('Invalid ' + name + ' record');
            keys.add(entry.key);
        }
    }
    if (!stores.metadata.some(entry => entry.key === 'progress-schema-version' && entry.value === 3)) throw new Error('Unsupported progress backup schema');
    return snapshot;
}
