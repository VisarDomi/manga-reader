import { describe, expect, it } from 'vitest';
import { decryptValirTile, deriveValirTileKey } from '../../src/provider/valir-tiles';

function toBase64(bytes: Uint8Array): string {
    let out = '';
    for (const byte of bytes) out += String.fromCharCode(byte);
    return btoa(out);
}

describe('valir tiles', () => {
    it('decrypts a tile with the site AES-256-GCM scheme', async () => {
        const keyBytes = crypto.getRandomValues(new Uint8Array(32));
        const ivBytes = crypto.getRandomValues(new Uint8Array(12));
        const payload = new TextEncoder().encode('hello encrypted webp');
        const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
        const cipher = new Uint8Array(await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: ivBytes, tagLength: 128 },
            key,
            payload,
        ));

        const plain = await decryptValirTile(toBase64(keyBytes), toBase64(ivBytes), toBase64(cipher));
        expect(new TextDecoder().decode(plain)).toBe('hello encrypted webp');
    });

    it('decrypts with the per-tile derived key ("tile:" + index)', async () => {
        const pageKeyBytes = crypto.getRandomValues(new Uint8Array(32));
        const pageKey = toBase64(pageKeyBytes);
        const tileKey = await deriveValirTileKey(pageKey, 3);
        const ivBytes = crypto.getRandomValues(new Uint8Array(12));
        const payload = new TextEncoder().encode('tile three');
        const key = await crypto.subtle.importKey('raw', pageKeyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const derived = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('tile:3')));
        expect(tileKey).toBe(toBase64(derived));

        const aesKey = await crypto.subtle.importKey('raw', derived, { name: 'AES-GCM' }, false, ['encrypt']);
        const cipher = new Uint8Array(await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: ivBytes, tagLength: 128 },
            aesKey,
            payload,
        ));
        const plain = await decryptValirTile(tileKey, toBase64(ivBytes), toBase64(cipher));
        expect(new TextDecoder().decode(plain)).toBe('tile three');
    });

    it('rejects a tampered tile (GCM authentication)', async () => {
        const keyBytes = crypto.getRandomValues(new Uint8Array(32));
        const ivBytes = crypto.getRandomValues(new Uint8Array(12));
        const payload = new TextEncoder().encode('tamper me');
        const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
        const cipher = new Uint8Array(await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: ivBytes, tagLength: 128 },
            key,
            payload,
        ));
        cipher[0] ^= 0xff;

        await expect(decryptValirTile(toBase64(keyBytes), toBase64(ivBytes), toBase64(cipher))).rejects.toThrow();
    });
});
