import type { Manga } from '../types.js';

const DB_NAME = 'comix-reader';
const DB_VERSION = 2;

interface ProgressEntry {
    mangaSlug: string;
    chapterId: string;
    chapterNumber: number;
    pageIndex?: number;
    pageCount?: number;
    scrollOffset?: number;
}

export type ProgressData = { chapterId: string; chapterNumber: number; pageIndex?: number; pageCount?: number; scrollOffset?: number };

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

// --- Progress --- keyed by mangaSlug, stores { chapterId, chapterNumber }

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
            resolve(data);
        };
        req.onerror = () => { console.error('[db] getProgress failed:', req.error); resolve(null); };
    });
}

export async function setProgress(mangaSlug: string, data: ProgressData): Promise<void> {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction('progress', 'readwrite');
        tx.objectStore('progress').put({ mangaSlug, ...data } satisfies ProgressEntry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => { console.error('[db] setProgress failed:', tx.error); resolve(); };
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
                map[entry.mangaSlug] = data;
            }
            resolve(map);
        };
        req.onerror = () => { console.error('[db] getAllProgress failed:', req.error); resolve({}); };
    });
}

// --- Favorites --- keyed by manga id

export async function getAllFavorites(): Promise<Manga[]> {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction('favorites', 'readonly');
        const req = tx.objectStore('favorites').getAll();
        req.onsuccess = () => resolve(req.result as Manga[]);
        req.onerror = () => { console.error('[db] getAllFavorites failed:', req.error); resolve([]); };
    });
}

export async function addFavorite(manga: Manga): Promise<void> {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction('favorites', 'readwrite');
        tx.objectStore('favorites').put(manga);
        tx.oncomplete = () => resolve();
        tx.onerror = () => { console.error('[db] addFavorite failed:', tx.error); resolve(); };
    });
}

export async function removeFavorite(id: string): Promise<void> {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction('favorites', 'readwrite');
        tx.objectStore('favorites').delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => { console.error('[db] removeFavorite failed:', tx.error); resolve(); };
    });
}
