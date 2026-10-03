import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MangaState, handler } from './backups.mjs';

const snapshot = (chapter = '2', updatedAt = 100) => ({ version: 1, indexedDB: {
    progress: [{ id: 'asurascans\0fixture', provider: 'asurascans', seriesSlug: 'fixture', chapterId: chapter, imageIndex: 2, totalImages: 10, updatedAt }],
    tokens: [], metadata: [{ key: 'progress-schema-version', value: 3 }] } });

test('manual save replaces older/backward/empty state without merging and retains previous', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-manga-'));
    try {
        const state = new MangaState(root);
        state.save('asurascans', snapshot('9', 200));
        state.save('asurascans', snapshot('2', 100));
        assert.deepEqual(new MangaState(root).read('asurascans'), snapshot('2', 100));
        const empty = snapshot();
        empty.indexedDB.progress = [];
        state.save('asurascans', empty);
        assert.deepEqual(state.read('asurascans'), empty);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'manual-manga-asurascans.json'), 'utf8')).previous, snapshot('2', 100));
        assert.throws(() => state.save('asurascans', { version: 1 }));
        assert.deepEqual(state.read('asurascans'), empty);
        assert.throws(() => state.save('../elsewhere', snapshot()));
        assert.equal(fs.statSync(path.join(root, 'manual-manga-asurascans.json')).mode & 0o777, 0o600);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('discovery contains no history; Load/Save are authenticated', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-api-'));
    const server = http.createServer(handler(root)).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
    const url = `http://127.0.0.1:${server.address().port}/api/reader-backups/manual/manga-reader/asurascans`;
    assert.equal((await fetch(url + '/status')).status, 401);
    const headers = { 'X-Reader-Backup-Key': fs.readFileSync(path.join(root, 'access-key'), 'utf8'), 'Content-Type': 'application/json' };
    assert.deepEqual(await (await fetch(url + '/status', { headers })).json(), { available: true });
    assert.equal((await fetch(url.replace('asurascans', 'unknown') + '/status', { headers })).status, 400);
    assert.equal((await fetch(url, { headers })).status, 404);
    const put = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(snapshot()) });
    assert.equal(put.status, 200);
    assert.equal(put.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await (await fetch(url, { headers })).json(), snapshot());
    assert.equal((await fetch(url, { method: 'PUT', headers, body: '{"version":1}' })).status, 400);
    assert.deepEqual(await (await fetch(url, { headers })).json(), snapshot());
});
