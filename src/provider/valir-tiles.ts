// Valir encrypted-page pipeline. Owned entirely by the provider: fetchChapter
// returns ordinary displayable image URLs, so the reader core never learns
// anything about tiles, keys, or decryption.

// Protocol (extracted from the site on 2025):
//   GET /api/tiles/{pageId}/all  (session) ->
//       { key: base64 (32 bytes), tiles: [{ tileIndex, x, y, width, height, iv, data }] }
//   each tile: AES-256-GCM decrypt(key, iv, tagLength 128) -> a webp tile
//   tiles are composed at their (x, y) into one canvas-sized image.

import { SITE_CONFIG } from '../core/sites';

const DOMAIN = SITE_CONFIG['valirscans'].domain;
const pageCache = new Map<string, Promise<string>>();

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/** Pure AES-256-GCM tile decryption (exported for tests). */
export async function decryptValirTile(key: string, iv: string, data: string): Promise<Uint8Array<ArrayBuffer>> {
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        base64ToBytes(key),
        { name: 'AES-GCM' },
        false,
        ['decrypt'],
    );
    const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBytes(iv), tagLength: 128 },
        cryptoKey,
        base64ToBytes(data),
    );
    return new Uint8Array(plain as ArrayBuffer);
}

/** Derive a tile's AES key: HMAC-SHA256 over "tile:{index}" with the page key. */
export async function deriveValirTileKey(pageKey: string, tileIndex: number): Promise<string> {
    const hmacKey = await crypto.subtle.importKey(
        'raw',
        base64ToBytes(pageKey),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const signature = new Uint8Array(await crypto.subtle.sign(
        'HMAC',
        hmacKey,
        new TextEncoder().encode('tile:' + tileIndex),
    ));
    return btoa(String.fromCharCode(...signature));
}

interface ValirTile {
    tileIndex: number;
    x: number;
    y: number;
    width: number;
    height: number;
    iv: string;
    data: string;
}

async function decryptValirPageUncached(pageId: string, width: number, height: number): Promise<string> {
    const res = await fetch(`https://${DOMAIN}/api/tiles/${pageId}/all`, {
        credentials: 'same-origin',
        cache: 'no-store',
    });
    if (!res.ok) throw new Error('Valir tiles failed: ' + res.status);
    const json = await res.json() as { key?: unknown; tiles?: unknown };
    if (typeof json.key !== 'string' || json.key.length === 0) {
        throw new Error('Valir tiles response is missing the key');
    }
    if (!Array.isArray(json.tiles) || json.tiles.length === 0) {
        throw new Error('Valir tiles response is missing tiles');
    }

    const key = json.key;
    const tiles = json.tiles as Array<Record<string, unknown>>;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');

    // All tiles of a page decrypt independently — run them in parallel and
    // draw in index order once each bitmap is ready.
    const bitmaps = await Promise.all(tiles.map(async entry => {
        const tile = entry as unknown as ValirTile;
        if (typeof tile.iv !== 'string' || typeof tile.data !== 'string') {
            throw new Error('Valir tile is missing iv or data');
        }
        if (typeof tile.tileIndex !== 'number') {
            throw new Error('Valir tile is missing tileIndex');
        }
        const tileKey = await deriveValirTileKey(key, tile.tileIndex);
        const plain = await decryptValirTile(tileKey, tile.iv, tile.data);
        return { tile, bitmap: await createImageBitmap(new Blob([plain], { type: 'image/webp' })) };
    }));
    for (const { tile, bitmap } of bitmaps) {
        // x/y are tile-grid indices (512px cells); width/height are the
        // tile's own pixel size (edge tiles are narrower/shorter).
        ctx.drawImage(bitmap, tile.x * 512, tile.y * 512, tile.width, tile.height);
        bitmap.close();
    }

    const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(value => {
            if (value) resolve(value);
            else reject(new Error('Canvas export failed'));
        }, 'image/webp');
    });
    return URL.createObjectURL(blob);
}

/**
 * Decrypt and assemble one encrypted page into a displayable object URL,
 * cached per pageId for the session.
 */
export function decryptValirPage(pageId: string, width: number, height: number): Promise<string> {
    const cached = pageCache.get(pageId);
    if (cached !== undefined) return cached;
    const promise = decryptValirPageUncached(pageId, width, height);
    pageCache.set(pageId, promise);
    void promise.catch(() => {
        pageCache.delete(pageId);
    });
    return promise;
}
