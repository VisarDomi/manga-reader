#!/usr/bin/env node
// PC Load/Save for the manga apps: HTTPS on port 7711 and a private access key.
// Each provider's file holds the current and previous complete reading state; Save replaces it.
//   node server/backups.mjs          serve
//   node server/backups.mjs status   print saved states (counts only)
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { durableWrite, privateDirectory } from './durable.mjs';
import { SEARCH_ROOT, Search, SearchInputError, searchModelsFromEnvironment } from './search.mjs';

export const PORT = 7711;
export const ROOT = path.join(os.homedir(), '.local/share/manga-reader/backups');
export const PROVIDERS = ['asurascans', 'ezmanga', 'qimanga', 'yakshacomics', 'scythescans', 'luacomic', 'violetscans'];
const LIMIT = 5 * 1024 * 1024;
const SEARCH_LIMIT = 1024 * 1024;

export function validateMangaState(data, provider) {
    const db = data?.indexedDB;
    if (data?.version !== 1 || !db || !['progress', 'tokens', 'metadata'].every(k => Array.isArray(db[k]))
        || !db.metadata.some(r => r?.key === 'progress-schema-version' && r.value === 3)) throw new Error('Invalid reading state');
    const ids = new Set();
    for (const p of db.progress) {
        if (!p || p.provider !== provider || typeof p.seriesSlug !== 'string' || !p.seriesSlug || typeof p.chapterId !== 'string' || !p.chapterId
            || p.id !== provider + '\0' + p.seriesSlug || ids.has(p.id) || !Number.isFinite(p.updatedAt)
            || !Number.isInteger(p.imageIndex) || !Number.isInteger(p.totalImages) || p.imageIndex < 0 || p.totalImages <= p.imageIndex) throw new Error('Invalid reading position');
        ids.add(p.id);
    }
    for (const kind of ['tokens', 'metadata']) {
        const keys = new Set();
        for (const r of db[kind]) {
            if (!r || typeof r.key !== 'string' || keys.has(r.key) || !Object.hasOwn(r, 'value')) throw new Error('Invalid reading metadata');
            keys.add(r.key);
        }
    }
}

export class MangaState {
    constructor(root) { this.root = root; privateDirectory(root); }
    file(provider) {
        if (!PROVIDERS.includes(provider)) throw new Error('Unknown provider');
        return path.join(this.root, 'manual-manga-' + provider + '.json');
    }
    read(provider) {
        try { return JSON.parse(fs.readFileSync(this.file(provider), 'utf8')).current; }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }
    save(provider, data) {
        validateMangaState(data, provider);
        // A deliberate Save replaces, including older/backward/empty progress.
        // Keep the prior complete snapshot for recovery without merging it.
        const previous = this.read(provider);
        durableWrite(this.file(provider), JSON.stringify({ current: data, previous, savedAt: new Date().toISOString() }));
    }
}

function send(res, status, value) {
    if (value?.error) res.reason = value.error;  // in the log line: the reason, not just the status
    if (value === undefined) res.writeHead(status).end();
    else res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
}

function readBody(req, limit = LIMIT) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => { size += chunk.length; if (size <= limit) chunks.push(chunk); });
        req.on('end', () => size > limit ? reject(Object.assign(new Error('Request too large'), { status: 413 })) : resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

/** /api/manga-reader/search/<provider>[/status] (search.mjs): whether search is offered, and a search. */
async function searchRoute(search, req, res, provider, action, depth) {
    if (!PROVIDERS.includes(provider)) return send(res, 400, { error: 'Unknown provider' });
    if (req.method === 'GET' && action === 'status' && depth === 5) return send(res, 200, await search.status());
    if (req.method === 'POST' && depth === 4) {
        let body;
        try { body = JSON.parse(await readBody(req, SEARCH_LIMIT)); }
        catch (error) { return send(res, error.status ?? 400, { error: 'Invalid search' }); }
        try { return send(res, 200, await search.search(provider, body?.query, body?.titles)); }
        catch (error) {
            if (error instanceof SearchInputError) return send(res, 400, { error: error.message });
            return send(res, 503, { error: 'Search unavailable' });
        }
    }
    return send(res, 404, { error: 'Not found' });
}

/** Request handler for /api/reader-backups/manual/manga-reader/<provider>[/status] and the search (searchRoute). */
export function handler(root, { search } = {}) {
    const state = new MangaState(root);
    const keyFile = path.join(root, 'access-key');
    if (!fs.existsSync(keyFile)) durableWrite(keyFile, randomBytes(32).toString('hex'));
    const key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim());
    return async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        const supplied = Buffer.from(String(req.headers['x-reader-backup-key'] ?? ''));
        if (key.length !== supplied.length || !timingSafeEqual(key, supplied)) return send(res, 401, { error: 'Backup access key required' });
        try {
            const parts = new URL(req.url, 'https://localhost').pathname.split('/').filter(Boolean).map(decodeURIComponent);
            if (search && parts.slice(0, 3).join('/') === 'api/manga-reader/search') return await searchRoute(search, req, res, parts[3], parts[4], parts.length);
            if (parts.slice(0, 4).join('/') !== 'api/reader-backups/manual/manga-reader') return send(res, 404, { error: 'Not found' });
            const [provider, action] = parts.slice(4);
            if (req.method === 'GET' && action === 'status' && parts.length === 6) {
                // Availability only: no reading snapshot is touched by discovery.
                return PROVIDERS.includes(provider) ? send(res, 200, { available: true }) : send(res, 400);
            }
            if (req.method === 'GET' && parts.length === 5) {
                let data;
                try { data = state.read(provider); } catch { return send(res, 400, { error: 'Reading state unavailable' }); }
                return data === null ? send(res, 404) : send(res, 200, data);
            }
            if (req.method === 'PUT' && parts.length === 5) {
                try { state.save(provider, JSON.parse(await readBody(req))); }
                catch (error) { return send(res, error.status ?? 400, { error: 'Invalid reading state' }); }
                return send(res, 200, { saved: true });
            }
            return send(res, 404, { error: 'Not found' });
        } catch {
            return send(res, 400, { error: 'Invalid request' });
        }
    };
}

function status(root) {
    const state = new MangaState(root);
    const rows = PROVIDERS.flatMap(provider => {
        const file = state.file(provider);
        if (!fs.existsSync(file)) return [];
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        return [{ provider, saved: saved.savedAt, series: saved.current.indexedDB.progress.length,
                  sessions: saved.current.indexedDB.tokens.length, previous: saved.previous ? 'yes' : 'none' }];
    });
    if (rows.length) console.table(rows);
    else console.log('No reading state saved yet.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    if (process.argv[2] === 'status') status(ROOT);
    else {
        const tls = { key: fs.readFileSync(path.join(os.homedir(), '.local/share/mkcert/pwa/key.pem')),
                      cert: fs.readFileSync(path.join(os.homedir(), '.local/share/mkcert/pwa/cert.pem')) };
        const handle = handler(ROOT, { search: new Search({ root: SEARCH_ROOT, models: searchModelsFromEnvironment() }) });
        https.createServer(tls, (req, res) => {
            res.on('finish', () => console.log(req.method, new URL(req.url, 'https://localhost').pathname, res.statusCode, ...(res.reason ? [res.reason] : [])));
            handle(req, res);
        }).listen(PORT, '0.0.0.0', () => console.log('Manga Reader Load/Save on port ' + PORT));
    }
}
