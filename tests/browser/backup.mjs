// Real IndexedDB transaction test in an isolated, disposable Chromium profile.
// No provider pages, phone storage, persistent browser profiles or real backups are touched.
import assert from 'node:assert/strict';
import http from 'node:http';
import { build } from 'esbuild';
import { chromium } from '../../../gallery-downloader/node_modules/playwright-core/index.mjs';

const bundle = await build({ entryPoints: ['src/core/compute/store.ts'], bundle: true, write: false, format: 'iife', globalName: 'BackupStore' });
const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Backup transaction fixture</title>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
    const page = await browser.newPage();
    const url = `http://127.0.0.1:${server.address().port}/`;
    await page.goto(url);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const result = await page.evaluate(async () => {
        const initial = {
            version: 1,
            indexedDB: {
                progress: [{ id: 'asurascans\u0000fixture', provider: 'asurascans', seriesSlug: 'fixture', chapterId: '8', imageIndex: 3, totalImages: 10, updatedAt: 100 }],
                tokens: [{ key: 'asura:access_token', value: 'FAKE-TEST-TOKEN' }],
                metadata: [{ key: 'progress-schema-version', value: 3 }, { key: 'test-metadata', value: { preserved: true } }],
            },
        };
        await BackupStore.restoreDatabaseBackup(initial);
        const before = await BackupStore.databaseBackup();
        const broken = structuredClone(before);
        broken.indexedDB.progress[0].imageIndex = 9;
        broken.indexedDB.tokens[0].value = () => {}; // put throws DataCloneError AFTER progress.clear/put
        let rejected = false;
        try { await BackupStore.restoreDatabaseBackup(broken); } catch { rejected = true; }
        const afterFailedTransaction = await BackupStore.databaseBackup();
        await BackupStore.progressPut({ ...initial.indexedDB.progress[0], imageIndex: 6 });
        const changed = await BackupStore.databaseBackup();
        await BackupStore.restoreDatabaseBackup(initial);
        return { before, afterFailedTransaction, rejected, changed, restored: await BackupStore.databaseBackup() };
    });
    assert.equal(result.rejected, true);
    assert.deepEqual(result.afterFailedTransaction, result.before);
    assert.equal(result.changed.indexedDB.progress[0].imageIndex, 6);
    assert.deepEqual(result.restored, result.before);
    await page.reload();
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    assert.deepEqual(await page.evaluate(() => BackupStore.databaseBackup()), result.before);
    console.log('PASS: real IndexedDB full-store round trip, transaction rollback, token/metadata preservation, and reload persistence');
} finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
}
