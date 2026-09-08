// Complementary packaging/worker check, not a substitute for iPhone Safari.
// Install the real extension in a disposable profile. ALL network hosts resolve
// to this local fixture; real provider accounts, phone data and backups stay untouched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { chromium } from '../../../gallery-downloader/node_modules/playwright-core/index.mjs';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-extension-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${temporary}/key.pem`, '-out', `${temporary}/cert.pem`, '-days', '1', '-subj', '/CN=manga-extension-fixture'], { stdio: 'ignore' });
const sites = JSON.parse(fs.readFileSync('src/core/sites.json', 'utf8'));
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="300"><rect width="100" height="300" fill="#456"/></svg>';
const cover = 'https://images.fixture/cover.svg';
const chapter = { slug: 'chapter-1', number: 1, price: 0, becameFreeAt: null, createdAt: '2026-01-01' };
const series = { slug: 'fixture', title: 'Fixture', cover, chapters: [chapter] };
const original = '<!doctype html><script>window.originalRan=true</script><p id="original">Original</p>';
const server = https.createServer({ key: fs.readFileSync(`${temporary}/key.pem`), cert: fs.readFileSync(`${temporary}/cert.pem`) }, (req, res) => {
    const url = new URL(req.url, `https://${req.headers.host}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    const json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
    if (url.hostname === '192.168.1.197') { res.writeHead(503); res.end(); return; }
    if (url.hostname === 'images.fixture') { res.setHeader('Content-Type', 'image/svg+xml'); res.end(svg); return; }
    if (['vapi.ezmanga.org', 'api.qimanga.com'].includes(url.hostname)) {
        json({ data: [series], totalItems: 1, totalPages: 1, next: null }); return;
    }
    if (url.hostname === 'api.asurascans.com') {
        if (!url.pathname.endsWith('/series')) { json({ data: [] }); return; }
        json({ data: [{ slug: 'fixture', title: 'Fixture', cover, public_url: '/comics/fixture-12345678', latest_chapters: [{ number: 1, is_premium: false, early_access_until: null, published_at: '2026-01-01' }] }], meta: { total: 1, has_more: false } }); return;
    }
    if (url.hostname === 'api.luacomic.org') {
        json({ data: [{ title: 'Fixture', series_slug: 'fixture', thumbnail: cover, paid_chapters: [], free_chapters: [{ chapter_name: 'Chapter 1', chapter_slug: 'chapter-1', created_at: '2026-01-01' }] }], meta: { total: 1 } }); return;
    }
    res.setHeader('Content-Type', 'text/html');
    if (url.hostname === 'scythescans.com' && ['/', '/manga/'].includes(url.pathname)) {
        res.end(original + `<div class="bixbox"><div class="releases"><h2>Latest Update</h2></div><div class="listupd"><div class="bs"><div class="bsx"><a href="https://scythescans.com/manga/fixture/"><img src="${cover}"><span class="tt">Fixture</span><span class="epxs">Chapter 1</span></a></div><ul class="chfiv"><li><a href="https://scythescans.com/fixture-chapter-1/">Chapter 1</a></li></ul></div></div></div>`); return;
    }
    if (url.hostname === 'yakshacomics.com' && url.pathname === '/') {
        res.end(original + `<div class="page-listing-item"><div class="page-item-detail"><div class="post-title"><a href="/manga/fixture/">Fixture</a></div><div class="item-thumb"><img src="${cover}"></div><div class="list-chapter"><div class="chapter-item"><span class="chapter"><a href="/manga/fixture/chapter-1/">Chapter 1</a></span></div></div></div></div>`); return;
    }
    res.end(original);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let context;
try {
    const extension = path.resolve('dist/extension');
    context = await chromium.launchPersistentContext(`${temporary}/profile`, {
        executablePath: '/usr/bin/chromium', headless: true, ignoreHTTPSErrors: true,
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, `--host-resolver-rules=MAP * 127.0.0.1:${server.address().port}, EXCLUDE localhost`, '--no-proxy-server', '--ignore-certificate-errors'],
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const { domain } of Object.values(sites)) {
        await page.goto(`https://${domain}/`, { waitUntil: 'commit' });
        // Chromium can stop rAF polling when a document-start extension stops
        // the parser; observe DOM state on a timer, not its animation lifecycle.
        await page.waitForFunction(() => /^Loaded 1(?: of 1)? series$/.test(document.querySelector('.hs-home-catalog-status')?.textContent ?? ''), null, { polling: 50 }).catch(async error => {
            console.error(domain, errors, await page.evaluate(() => ({ boot: window.__mangaExtensionBoot, text: document.body?.innerText, hidden: document.hidden })));
            throw error;
        });
        assert.equal(await page.locator('.hs-home-card').count(), 1, `${domain}: merged catalog has no duplicates`);
        assert.equal(await page.locator('.hs-home-chapter').count(), 1);
        assert.equal(await page.locator('#original').count(), 0);
        assert.equal(await page.locator('#reader-backup-setup').count(), 0, 'Offline backup server does not prompt');
        assert.equal(await page.locator('meta[name=viewport]').getAttribute('content'), 'width=device-width, initial-scale=1');
        assert.equal(await page.evaluate(() => document.compatMode), 'CSS1Compat');
        const href = await page.locator('.hs-home-chapter').getAttribute('href');
        assert.equal(new URL(href).hostname, domain, 'Native reader link stays on its provider');
        // A complete home/history result requires the real worker/IndexedDB path.
        assert.ok(await page.evaluate(() => window.__mangaExtensionBoot.readyAt > 0));
        await page.goto(`https://${domain}/account/settings`, { waitUntil: 'load' });
        assert.equal(await page.locator('#original').count(), 1);
        assert.equal(await page.evaluate(() => window.originalRan), true);
        assert.equal(await page.evaluate(() => !!window.__mangaExtensionBoot), false);
        console.log(`${domain}: installed takeover, catalog, worker, native links, viewport, silent unavailable backup, unowned route PASS`);
    }
    assert.deepEqual(errors, []);
} finally {
    await context?.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
}
