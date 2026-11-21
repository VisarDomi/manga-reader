import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { handler } from './backups.mjs';
import { ModelUnavailable, OpencodeModel, ReplyError, Search, SearchInputError, buildPrompt, orderTitles, parseReply } from './search.mjs';

const titles = [{ id: 'b', title: 'Genius Magic Swordsman Returns' }, { id: 'a', title: 'Return of the Mount Hua Sect' }, { id: 'c', title: 'The Dignity of a Chaebol' }];
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'manga-search-'));

/** A model that answers from a queue of replies (strings, or errors to throw) and counts questions. */
function model(name, ...replies) {
    return { name, asked: [], async ask(text, options) { this.asked.push({ text, options }); const next = replies.shift(); if (next instanceof Error) throw next; return next; } };
}

test('the prompt lists titles in a fixed order with the query last; replies map back to sent titles only', () => {
    const ordered = orderTitles(titles);
    assert.deepEqual(ordered.map(t => t.id), ['b', 'a', 'c']);
    assert.deepEqual(orderTitles([...titles].reverse()), ordered);
    const prompt = buildPrompt(ordered, 'mount hua');
    assert.ok(prompt.indexOf('0|Genius Magic Swordsman Returns') < prompt.indexOf('"mount hua"'));
    assert.match(prompt.split('\n').at(-2), /at most 20/);
    assert.deepEqual(parseReply('Sure: {"matches":[{"i":1,"c":97},{"i":1,"c":50},{"i":7,"c":40},{"i":"0","c":30},{"i":2,"c":250},{"i":0}]}', ordered),
        [{ id: 'a', confidence: 97 }, { id: 'c', confidence: 100 }, { id: 'b', confidence: 0 }]);
    assert.deepEqual(parseReply('{"matches":[]}', ordered), []);
    assert.throws(() => parseReply('no idea', ordered), ReplyError);
    assert.throws(() => parseReply('{"matches": 3}', ordered), ReplyError);
    const many = Array.from({ length: 40 }, (_, i) => ({ id: 'id' + i, title: 'Title ' + String(i).padStart(2, '0') }));
    assert.equal(parseReply(JSON.stringify({ matches: many.map((_, i) => ({ i, c: 50 })) }), orderTitles(many)).length, 20);
});

test('availability: offered while the main model or the fallback says hi; a failure hides a model for one minute or until the provider reset', async () => {
    let now = 1_000_000;
    const main = model('haiku', 'Hi!', new ModelUnavailable('Free usage limit reached', now + 5 * 60_000 + 3_600_000), 'hi');
    const fallback = model('deepseek', 'hello there', 'hi');
    const search = new Search({ root: temporary(), models: [main, fallback], now: () => now });
    const [first, second] = await Promise.all([search.status(), search.status()]);
    assert.deepEqual([first, second], [{ ready: true }, { ready: true }]);
    assert.equal(main.asked.length, 1, 'concurrent checks share one question');
    assert.equal(fallback.asked.length, 0, 'the fallback is not asked while the main model answers');
    assert.equal(main.asked[0].text, 'say hi and only hi');
    now += 4 * 60_000;
    assert.deepEqual(await search.status(), { ready: true });
    assert.equal(main.asked.length, 1, 'a pass counts for five minutes');
    now += 61_000;
    assert.deepEqual(await search.status(), { ready: false }, 'main refused, and the fallback did not say just hi');
    assert.deepEqual([main.asked.length, fallback.asked.length], [2, 1]);
    now += 61_000;
    assert.deepEqual(await search.status(), { ready: true }, 'the fallback alone offers search');
    assert.deepEqual([main.asked.length, fallback.asked.length], [2, 2], 'the main model is not asked before its reset');
    now += 60 * 60_000;
    assert.deepEqual(await search.status(), { ready: true });
    assert.equal(main.asked.length, 3, 'after the reset the main model is asked again');
});

test('search: validated, cached durably by query and title set, shared while running; the fallback answers when the main model cannot', async () => {
    const root = temporary();
    let release;
    const main = { name: 'haiku', asked: 0, async ask() { this.asked++; await new Promise(resolve => { release = resolve; }); return '{"matches":[{"i":1,"c":95}]}'; } };
    const search = new Search({ root, models: [main, model('deepseek')] });
    for (const [query, list] of [['', titles], ['x'.repeat(201), titles], ['ok', []], ['ok', [{ id: 'a', title: '' }]], ['ok', [{ id: '', title: 'x' }]], [3, titles]]) {
        await assert.rejects(search.search('qimanga', query, list), SearchInputError);
    }
    const running = [search.search('qimanga', 'Mount  HUA', titles), search.search('qimanga', 'mount hua', [...titles].reverse())];
    await new Promise(resolve => setImmediate(resolve));
    release();
    assert.deepEqual(await Promise.all(running), [{ matches: [{ id: 'a', confidence: 95 }] }, { matches: [{ id: 'a', confidence: 95 }] }]);
    assert.equal(main.asked, 1);
    const reopened = new Search({ root, models: [model('haiku')] });
    assert.deepEqual(await reopened.search('qimanga', 'mount hua', titles), { matches: [{ id: 'a', confidence: 95 }] }, 'answered from the saved cache');
    assert.equal(fs.statSync(path.join(root, 'cache.json')).mode & 0o777, 0o600);

    const haiku = model('haiku', 'not json', new ModelUnavailable('down'));
    const deepseek = model('deepseek', '{"matches":[{"i":0,"c":70}]}', '{"matches":[{"i":2,"c":60}]}', new ModelUnavailable('down too'));
    const both = new Search({ root: temporary(), models: [haiku, deepseek] });
    assert.deepEqual(await both.search('qimanga', 'a', titles), { matches: [{ id: 'b', confidence: 70 }] }, 'a bad main reply falls back');
    assert.deepEqual(await both.status(), { ready: true });
    assert.deepEqual(await both.search('qimanga', 'b', titles), { matches: [{ id: 'c', confidence: 60 }] }, 'a refused main model falls back');
    assert.deepEqual([haiku.asked.length, deepseek.asked.length], [2, 2]);
    await assert.rejects(both.search('qimanga', 'c', titles), ModelUnavailable);
    assert.equal(haiku.asked.length, 2, 'a model known to be down is not asked');
    assert.deepEqual(await both.status(), { ready: false });
});

test('HTTP: same key as Load/Save; status, search, input errors and model failures', async t => {
    const root = temporary();
    const search = new Search({ root: temporary(), models: [model('haiku', 'hi', '{"matches":[{"i":2,"c":80}]}', new ModelUnavailable('down'))] });
    const server = http.createServer(handler(root, { search })).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => { await new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}/api/manga-reader/search`;
    const headers = { 'X-Reader-Backup-Key': fs.readFileSync(path.join(root, 'access-key'), 'utf8'), 'Content-Type': 'application/json' };
    assert.equal((await fetch(base + '/qimanga/status')).status, 401);
    const status = await fetch(base + '/qimanga/status', { headers });
    assert.deepEqual([status.status, await status.json(), status.headers.get('Cache-Control')], [200, { ready: true }, 'no-store']);
    assert.equal((await fetch(base + '/elsewhere/status', { headers })).status, 400);
    const post = body => fetch(base + '/qimanga', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const found = await post({ query: 'chaebol', titles });
    assert.deepEqual([found.status, await found.json()], [200, { matches: [{ id: 'c', confidence: 80 }] }]);
    assert.equal((await post('{')).status, 400);
    assert.equal((await post({ query: ' ', titles })).status, 400);
    assert.equal((await post({ query: 'another', titles })).status, 503);
    assert.equal((await fetch(base + '/qimanga', { method: 'PUT', headers, body: '{}' })).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/reader-backups/manual/manga-reader/qimanga/status`, { headers })).status, 200, 'Load/Save unchanged');
});

test('OpenCode: one session per question with the tool-less agent and no permissions, always deleted', async t => {
    const calls = [];
    let reply = { type: 'assistant', content: [{ type: 'text', text: 'hi' }] };
    const server = http.createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
        const json = value => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
        if (req.method === 'POST' && req.url === '/api/session') return json({ data: { id: 'ses_1' } });
        if (req.url === '/api/session/ses_1/message') return json({ data: [{ type: 'user', text: 'q' }, reply] });
        if (req.url === '/api/experimental/session/ses_1/wait' && reply === 'hang') return;  // never answers
        return json({ data: {} });
    }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const opencode = new OpencodeModel({ name: 'haiku', model: { providerID: 'opencode-go', id: 'claude-haiku-5-5', variant: 'xhigh' },
        url: `http://127.0.0.1:${server.address().port}`, password: 'pw', directory: '/srv/search' });

    assert.equal(await opencode.ask('say hi and only hi', { timeout: 5000 }), 'hi');
    assert.deepEqual(calls.map(c => `${c.method} ${c.url}`), ['POST /api/session', 'POST /api/session/ses_1/prompt', 'POST /api/experimental/session/ses_1/wait',
        'GET /api/session/ses_1/message', 'DELETE /api/session/ses_1']);
    assert.equal(calls[0].auth, 'Basic ' + Buffer.from('opencode:pw').toString('base64'));
    assert.deepEqual(calls[0].body, { agent: 'answer', title: 'manga search', model: { providerID: 'opencode-go', id: 'claude-haiku-5-5', variant: 'xhigh' },
        location: { directory: '/srv/search' }, permissions: [{ action: '*', resource: '*', effect: 'deny' }] });
    assert.deepEqual(calls[1].body, { text: 'say hi and only hi' });

    calls.length = 0;
    reply = { type: 'assistant', content: [], error: { type: 'provider.free-limit', message: 'Free usage limit reached', retryAfterMs: 60_000 } };
    const before = Date.now();
    const refused = await opencode.ask('x', { timeout: 5000 }).catch(error => error);
    assert.ok(refused instanceof ModelUnavailable && refused.retryAt >= before + 60_000);
    assert.equal(calls.at(-1).method, 'DELETE');

    calls.length = 0;
    reply = 'hang';
    await assert.rejects(opencode.ask('x', { timeout: 300 }), ModelUnavailable);
    assert.deepEqual(calls.slice(-2).map(c => `${c.method} ${c.url}`), ['POST /api/session/ses_1/interrupt', 'DELETE /api/session/ses_1']);
});

test('search: entries no search can use are left out, not a failed search (EzScans lists a series with an empty slug)', async () => {
    let prompt;
    const main = { name: 'haiku', async ask(text) { prompt = text; return '{"matches":[{"i":1,"c":90}]}'; } };
    const search = new Search({ root: temporary(), models: [main] });
    const listed = [...titles, { id: '', title: '숨은 신록 끝에서' }, { id: 'd', title: '  ' }, titles[1], { id: 'e', title: 'x'.repeat(401) }];
    assert.deepEqual(await search.search('ezmanga', 'mount hua', listed), await new Search({ root: temporary(), models: [main] }).search('ezmanga', 'mount hua', titles));
    assert.ok(!prompt.includes('숨은') && !prompt.includes('x'.repeat(401)));
});
