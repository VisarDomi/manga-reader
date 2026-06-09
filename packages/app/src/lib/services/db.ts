const DB_NAME = 'comix-reader';
const DB_VERSION = 4;

interface ProgressEntry {
    mangaSlug: string;
    chapterId: string;
    chapterNumber: number;
    pageIndex?: number;
    pageCount?: number;
    scrollOffset?: number;
    rootScrollTop?: number;
    physicalWindowStart?: number;
}

export type ProgressData = { chapterId: string; chapterNumber: number; pageIndex?: number; pageCount?: number; scrollOffset?: number; rootScrollTop?: number; physicalWindowStart?: number };

type DbLogger = (op: string, error: string) => void;
let logger: DbLogger = () => {};

export function setDbLogger(fn: DbLogger): void {
    logger = fn;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('progress')) {
                db.createObjectStore('progress', { keyPath: 'mangaSlug' });
            }
            if (!db.objectStoreNames.contains('favorites')) {
                db.createObjectStore('favorites', { keyPath: 'id' });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

    return dbPromise;
}
export async function getProgress(mangaSlug: string): Promise<ProgressData | null> {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction('progress', 'readonly');
        const req = tx.objectStore('progress').get(mangaSlug);
        req.onsuccess = () => {
            const entry = req.result as ProgressEntry | undefined;
            if (!entry) return resolve(null);
            const data: ProgressData = { chapterId: String(entry.chapterId), chapterNumber: entry.chapterNumber };
            if (entry.pageIndex != null) data.pageIndex = entry.pageIndex;
            if (entry.pageCount != null) data.pageCount = entry.pageCount;
            if (entry.scrollOffset != null) data.scrollOffset = entry.scrollOffset;
            if (entry.rootScrollTop != null) data.rootScrollTop = entry.rootScrollTop;
            if (entry.physicalWindowStart != null) data.physicalWindowStart = entry.physicalWindowStart;
            resolve(data);
        };
        req.onerror = () => { logger('getProgress', String(req.error)); resolve(null); };
    });
}

export async function setProgress(mangaSlug: string, data: ProgressData): Promise<void> {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction('progress', 'readwrite');
        tx.objectStore('progress').put({ mangaSlug, ...data } satisfies ProgressEntry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => { logger('setProgress', String(tx.error)); resolve(); };
    });
}

export async function getAllProgress(): Promise<Record<string, ProgressData>> {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction('progress', 'readonly');
        const req = tx.objectStore('progress').getAll();
        req.onsuccess = () => {
            const map: Record<string, ProgressData> = {};
            for (const entry of req.result as ProgressEntry[]) {
                const data: ProgressData = { chapterId: String(entry.chapterId), chapterNumber: entry.chapterNumber };
                if (entry.pageIndex != null) data.pageIndex = entry.pageIndex;
                if (entry.pageCount != null) data.pageCount = entry.pageCount;
                if (entry.scrollOffset != null) data.scrollOffset = entry.scrollOffset;
                if (entry.rootScrollTop != null) data.rootScrollTop = entry.rootScrollTop;
                if (entry.physicalWindowStart != null) data.physicalWindowStart = entry.physicalWindowStart;
                map[entry.mangaSlug] = data;
            }
            resolve(map);
        };
        req.onerror = () => { logger('getAllProgress', String(req.error)); resolve({}); };
    });
}
interface FavoriteSnapshot {
    title: string;
    cover: string;
    latestChapter: number | null;
}

interface FavoriteEntry {
    id: string;
    providerId?: string;
    mangaId?: string;
    title?: string;
    cover?: string;
    latestChapter?: number | null;
}

export interface FavoriteIdRow {
    id: string;
    snapshot?: FavoriteSnapshot;
}

export interface FavoriteBackupRow extends FavoriteIdRow {
    providerId: string;
}

function favoriteId(entry: unknown): string {
    if (!entry || typeof entry !== 'object') return '';
    const record = entry as Record<string, unknown>;
    const mangaId = record.mangaId ?? record.id;
    return typeof mangaId === 'string' ? mangaId : '';
}

function favoriteProviderId(entry: unknown): string {
    if (!entry || typeof entry !== 'object') return 'comix';
    const providerId = (entry as Record<string, unknown>).providerId;
    return typeof providerId === 'string' && providerId.length > 0 ? providerId : 'comix';
}

function favoriteKey(providerId: string, mangaId: string): string {
    return `${providerId}:${mangaId}`;
}

function favoriteSnapshot(entry: unknown): FavoriteIdRow['snapshot'] | undefined {
    if (!entry || typeof entry !== 'object') return undefined;
    const record = entry as Record<string, unknown>;
    if (typeof record.title !== 'string' || typeof record.cover !== 'string') return undefined;
    const latest = record.latestChapter;
    return {
        title: record.title,
        cover: record.cover,
        latestChapter: typeof latest === 'number' ? latest : null,
    };
}

export async function getAllFavoriteRows(providerId = 'comix'): Promise<FavoriteIdRow[]> {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction('favorites', 'readonly');
        const store = tx.objectStore('favorites');
        const req = store.getAll();
        req.onsuccess = () => {
            const seen = new Set<string>();
            const rows: FavoriteIdRow[] = [];
            for (const entry of req.result as FavoriteEntry[]) {
                if (favoriteProviderId(entry) !== providerId) continue;
                const id = favoriteId(entry);
                if (!id || seen.has(id)) continue;
                seen.add(id);
                rows.push({ id, snapshot: favoriteSnapshot(entry) });
            }
            resolve(rows);
        };
        req.onerror = () => { logger('getAllFavoriteRows', String(req.error)); resolve([]); };
    });
}

export async function getFavoriteBackupRows(): Promise<FavoriteBackupRow[]> {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction('favorites', 'readonly');
        const req = tx.objectStore('favorites').getAll();
        req.onsuccess = () => {
            const seen = new Set<string>();
            const rows: FavoriteBackupRow[] = [];
            for (const entry of req.result as FavoriteEntry[]) {
                const providerId = favoriteProviderId(entry);
                const id = favoriteId(entry);
                const key = favoriteKey(providerId, id);
                if (!id || seen.has(key)) continue;
                seen.add(key);
                rows.push({ providerId, id, snapshot: favoriteSnapshot(entry) });
            }
            resolve(rows.sort((a, b) => `${a.providerId}:${a.id}`.localeCompare(`${b.providerId}:${b.id}`)));
        };
        req.onerror = () => { logger('getFavoriteBackupRows', String(req.error)); resolve([]); };
    });
}

export async function replaceFavoriteBackupRows(rows: FavoriteBackupRow[]): Promise<void> {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction('favorites', 'readwrite');
        const store = tx.objectStore('favorites');
        store.clear();
        for (const row of rows) {
            if (!row.providerId || !row.id) continue;
            store.put({
                id: favoriteKey(row.providerId, row.id),
                providerId: row.providerId,
                mangaId: row.id,
                title: row.snapshot?.title ?? row.id,
                cover: row.snapshot?.cover ?? '',
                latestChapter: row.snapshot?.latestChapter ?? null,
            } satisfies FavoriteEntry);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => { logger('replaceFavoriteBackupRows', String(tx.error)); resolve(); };
    });
}

export async function addFavorite(manga: { id: string; title: string; cover: string; latestChapter: number | null }, providerId = 'comix'): Promise<void> {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction('favorites', 'readwrite');
        tx.objectStore('favorites').put({
            id: favoriteKey(providerId, manga.id),
            providerId,
            mangaId: manga.id,
            title: manga.title,
            cover: manga.cover,
            latestChapter: manga.latestChapter,
        } satisfies FavoriteEntry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => { logger('addFavorite', String(tx.error)); resolve(); };
    });
}

export async function updateFavoriteSnapshot(manga: { id: string; title: string; cover: string; latestChapter: number | null }, providerId = 'comix'): Promise<void> {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction('favorites', 'readwrite');
        tx.objectStore('favorites').put({
            id: favoriteKey(providerId, manga.id),
            providerId,
            mangaId: manga.id,
            title: manga.title,
            cover: manga.cover,
            latestChapter: manga.latestChapter,
        } satisfies FavoriteEntry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => { logger('updateFavoriteSnapshot', String(tx.error)); resolve(); };
    });
}

export async function removeFavorite(id: string, providerId = 'comix'): Promise<void> {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction('favorites', 'readwrite');
        const store = tx.objectStore('favorites');
        store.delete(favoriteKey(providerId, id));
        if (providerId === 'comix') store.delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => { logger('removeFavorite', String(tx.error)); resolve(); };
    });
}
