// Worker-owned IndexedDB layer. This module must only ever run inside the
// compute worker (or a test seam); the main thread never touches IndexedDB.

import type { ChapterProgress } from './progress';
import {
    initialProgressSchema,
    migrateProgress,
    PROGRESS_SCHEMA_METADATA_KEY,
    ProgressSchemaVersion,
} from './migrations';

const DB_NAME = 'manga-reader-compute';
const DB_VERSION = 2;
const STORE_PROGRESS = 'progress';
const STORE_TOKENS = 'tokens';
const STORE_METADATA = 'metadata';

/** WebKit bug 251203: IDB requests can occasionally hang instead of erroring. */
const REQUEST_TIMEOUT_MS = 10_000;

let database: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
    if (database !== null) return database;
    database = new Promise((resolve, reject) => {
        const request = self.indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = event => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_PROGRESS)) {
                db.createObjectStore(STORE_PROGRESS, { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains(STORE_TOKENS)) {
                db.createObjectStore(STORE_TOKENS, { keyPath: 'key' });
            }
            if (!db.objectStoreNames.contains(STORE_METADATA)) {
                const metadata = db.createObjectStore(STORE_METADATA, { keyPath: 'key' });
                metadata.put({
                    key: PROGRESS_SCHEMA_METADATA_KEY,
                    value: initialProgressSchema(event.oldVersion),
                });
            }
        };
        request.onsuccess = () => {
            const opened = request.result;
            opened.onversionchange = () => {
                opened.close();
                database = null;
            };
            resolve(opened);
        };
        request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
        request.onblocked = () => reject(new Error('IndexedDB open blocked by another connection'));
    });
    void database.catch(() => {
        database = null; // allow retry after failure
    });
    return database;
}

function withTimeout<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = self.setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error('IndexedDB request timed out'));
        }, REQUEST_TIMEOUT_MS);
        request.onsuccess = () => {
            if (settled) return;
            settled = true;
            self.clearTimeout(timer);
            resolve(request.result);
        };
        request.onerror = () => {
            if (settled) return;
            settled = true;
            self.clearTimeout(timer);
            reject(request.error ?? new Error('IndexedDB request failed'));
        };
    });
}

function awaitTransaction(transaction: IDBTransaction): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = self.setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error('IndexedDB transaction timed out'));
        }, REQUEST_TIMEOUT_MS);
        transaction.oncomplete = () => {
            if (settled) return;
            settled = true;
            self.clearTimeout(timer);
            resolve();
        };
        transaction.onerror = () => {
            if (settled) return;
            settled = true;
            self.clearTimeout(timer);
            reject(transaction.error ?? new Error('IndexedDB transaction failed'));
        };
        transaction.onabort = () => {
            if (settled) return;
            settled = true;
            self.clearTimeout(timer);
            reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
        };
    });
}

async function commitProgressMigration(
    entries: ChapterProgress[],
    schemaVersion: ProgressSchemaVersion,
): Promise<void> {
    const db = await openDatabase();
    const transaction = db.transaction(
        [STORE_PROGRESS, STORE_METADATA],
        'readwrite',
        { durability: 'strict' },
    );
    const progress = transaction.objectStore(STORE_PROGRESS);
    progress.clear();
    for (const entry of entries) progress.put(entry);
    transaction.objectStore(STORE_METADATA).put({
        key: PROGRESS_SCHEMA_METADATA_KEY,
        value: schemaVersion,
    });
    await awaitTransaction(transaction);
}

/** Returns only current-schema positions; migration never leaks past storage. */
export async function loadProgress(): Promise<ChapterProgress[]> {
    const db = await openDatabase();
    const transaction = db.transaction([STORE_PROGRESS, STORE_METADATA], 'readonly');
    const entriesRequest = transaction.objectStore(STORE_PROGRESS).getAll();
    const schemaRequest = transaction.objectStore(STORE_METADATA).get(PROGRESS_SCHEMA_METADATA_KEY);
    const [storedEntries, storedSchema] = await Promise.all([
        withTimeout(entriesRequest),
        withTimeout(schemaRequest),
    ]);
    const result = migrateProgress(
        storedEntries,
        (storedSchema as { value?: unknown } | undefined)?.value,
    );
    if (result.needsCommit) {
        await commitProgressMigration(result.entries, result.schemaVersion);
    }
    return result.entries;
}

/** Progress saves use strict durability: transaction success means disk flush. */
export async function progressPut(entry: ChapterProgress): Promise<void> {
    const db = await openDatabase();
    const transaction = db.transaction(STORE_PROGRESS, 'readwrite', { durability: 'strict' });
    transaction.objectStore(STORE_PROGRESS).put(entry);
    await awaitTransaction(transaction);
}

export async function tokensGet(key: string): Promise<unknown> {
    const db = await openDatabase();
    const transaction = db.transaction(STORE_TOKENS, 'readonly');
    const request = transaction.objectStore(STORE_TOKENS).get(key);
    const value = await withTimeout(request);
    return (value as { key: string; value?: unknown } | undefined)?.value;
}

export async function tokensPut(key: string, value: unknown): Promise<void> {
    const db = await openDatabase();
    const transaction = db.transaction(STORE_TOKENS, 'readwrite');
    transaction.objectStore(STORE_TOKENS).put({ key, value });
    await awaitTransaction(transaction);
}
