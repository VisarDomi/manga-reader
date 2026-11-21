// Home search for the manga apps. The phone sends what was typed and its catalog's titles; a
// language model, reached through a local, stripped OpenCode server (manga-search-opencode.service:
// one tool-less agent, no plugins, MCP, project files or instructions; it signs in with the owner's
// existing OpenCode login), answers the titles it
// thinks were meant with a confidence, and the phone moves those to the top.
//
// - Two models, the main one first and a fallback (SEARCH_MODELS). Search is offered while either
//   answers "say hi and only hi" with "hi". A pass counts for five minutes, a failure for one
//   (longer when the provider names a reset time); a model known to be down is skipped meanwhile.
// - The same query on the same set of titles is answered from a durable cache (no model work).
// - Only titles the phone sent can come back, at most 20, best first; a reply that does not
//   parse is a failure, not an empty result, and does not take search offline (an unreachable
//   OpenCode or a provider refusal does).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { durableWrite, privateDirectory } from './durable.mjs';

export const SEARCH_ROOT = path.join(os.homedir(), '.local/share/manga-reader/search');
// The models, on the owner's OpenCode Go plan, in the order they are asked (server/README.md, "Search"):
// Claude Haiku 5.5 at xhigh reasoning, then GLM-5.3-Flash at high while Haiku is unavailable.
export const SEARCH_MODELS = [
    { name: 'haiku', ref: { providerID: 'opencode-go', id: 'claude-haiku-5-5', variant: 'xhigh' } },
    { name: 'glm', ref: { providerID: 'opencode-go', id: 'glm-5.3-flash', variant: 'high' } },
];
export const OPENCODE_URL = 'http://127.0.0.1:7712';

const READY_FOR = 5 * 60_000;
const OFFLINE_FOR = 60_000;
const OFFLINE_AT_MOST = 24 * 3600_000;
const CHECK_TIMEOUT = 30_000;
const SEARCH_TIMEOUT = 50_000;  // per model; the phone waits for both
const MAX_MATCHES = 20;
const MAX_QUERY = 200;
const MAX_TITLES = 5000;
const MAX_ID = 300;
const MAX_TITLE = 400;
const CACHE_ENTRIES = 500;

/** The request itself is wrong (400); everything else the model or OpenCode did is 503. */
export class SearchInputError extends Error {}

/** The model or OpenCode did not answer. `retryAt` (ms) is the provider's own reset time, if it said. */
export class ModelUnavailable extends Error {
    constructor(message, retryAt = null) { super(message); this.retryAt = retryAt; }
}

/** The model answered, but not with the asked-for JSON: this search failed, the model is still up. */
export class ReplyError extends Error {}

export const normalizeQuery = query => query.trim().replace(/\s+/g, ' ').toLowerCase();

/** The titles in a fixed order (by title, then id), so the prompt and the cache do not depend on catalog order. */
export function orderTitles(titles) {
    return [...titles].sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Titles first and the query last, so repeated searches of one catalog share a cached prefix. */
export function buildPrompt(ordered, query) {
    return ['You rank manga titles for a search box. Answer with JSON only.',
        'Titles, one per line as <number>|<title>:',
        ...ordered.map((entry, index) => `${index}|${entry.title.replace(/\s+/g, ' ')}`),
        `The user typed: ${JSON.stringify(query)}`,
        'Return the titles the user most likely means, best first, at most 20, only plausible matches, as:',
        '{"matches":[{"i":<number>,"c":<confidence 0-100 that this is the title the user means>}]}'].join('\n');
}

/** The model's reply as matches of the titles sent; throws when it is not the asked-for JSON. */
export function parseReply(text, ordered) {
    const found = /\{[\s\S]*\}/.exec(text ?? '');
    if (!found) throw new ReplyError('Reply without JSON');
    let matches;
    try { matches = JSON.parse(found[0]).matches; } catch { throw new ReplyError('Reply is not JSON'); }
    if (!Array.isArray(matches)) throw new ReplyError('Reply without matches');
    const seen = new Set(), result = [];
    for (const match of matches) {
        const index = match?.i, confidence = Number(match?.c);
        if (!Number.isInteger(index) || index < 0 || index >= ordered.length || seen.has(index)) continue;
        seen.add(index);
        result.push({ id: ordered[index].id, confidence: Number.isFinite(confidence) ? Math.round(Math.min(100, Math.max(0, confidence))) : 0 });
        if (result.length === MAX_MATCHES) break;
    }
    return result;
}

// The phone sends the site's catalog as it is, and a site can list an entry no search can use
// (EzScans lists a series with an empty slug). Such entries (no id, a blank title, too long, a
// repeated id) are left out rather than failing the whole search; only a request with nothing
// usable in it is invalid.
function usableTitles(query, titles) {
    if (typeof query !== 'string' || !query.trim() || query.length > MAX_QUERY) throw new SearchInputError('Invalid query');
    if (!Array.isArray(titles) || titles.length > MAX_TITLES) throw new SearchInputError('Invalid titles');
    const ids = new Set(), usable = [];
    for (const entry of titles) {
        if (typeof entry?.id !== 'string' || !entry.id || entry.id.length > MAX_ID || ids.has(entry.id)
            || typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > MAX_TITLE) continue;
        ids.add(entry.id);
        usable.push({ id: entry.id, title: entry.title.trim() });
    }
    if (usable.length === 0) throw new SearchInputError('No usable titles');
    return usable;
}

export class Search {
    /**
     * `models`: [{ name, ask(text, { timeout }) }], main first. `ask` answers text or throws
     * (ModelUnavailable when the model or OpenCode cannot answer).
     */
    constructor({ root, models, now = () => Date.now() }) {
        this.root = root; this.models = models; this.now = now;
        privateDirectory(root);
        this.cacheFile = path.join(root, 'cache.json');
        this.cache = new Map();
        try {
            for (const [key, value] of JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'))) this.cache.set(key, value);
        } catch (error) { if (error.code !== 'ENOENT') console.error('Search cache unreadable, starting empty:', error.message); }
        this.availability = new Map();  // model name -> { ready, until }
        this.checking = null;
        this.running = new Map();
    }

    known(model) {
        const state = this.availability.get(model.name);
        return state && this.now() < state.until ? state.ready : undefined;
    }

    /** { ready }: whether the phone should offer search now (the main model or the fallback answers). */
    async status() {
        const known = this.models.map(model => this.known(model));
        if (known.includes(true)) return { ready: true };
        if (known.every(ready => ready === false)) return { ready: false };
        this.checking ??= this.check().finally(() => { this.checking = null; });
        return { ready: await this.checking };
    }

    async check() {
        for (const model of this.models) {
            const known = this.known(model);
            if (known === true) return true;
            if (known === false) continue;
            try {
                const reply = await model.ask('say hi and only hi', { timeout: CHECK_TIMEOUT });
                const ready = String(reply).toLowerCase().replace(/[^a-z]/g, '') === 'hi';
                this.mark(model, ready);
                if (ready) return true;
            } catch (error) {
                this.mark(model, false, error.retryAt);
            }
        }
        return false;
    }

    mark(model, ready, retryAt = null) {
        const now = this.now();
        const until = ready ? now + READY_FOR : Math.min(now + OFFLINE_AT_MOST, Math.max(now + OFFLINE_FOR, retryAt ?? 0));
        this.availability.set(model.name, { ready, until });
    }

    /** { matches: [{ id, confidence }] }, best first. */
    async search(provider, query, titles) {
        const ordered = orderTitles(usableTitles(query, titles));
        const normalized = normalizeQuery(query);
        const key = createHash('sha256').update(JSON.stringify([provider, normalized, ordered.map(entry => [entry.id, entry.title])])).digest('hex');
        const cached = this.cache.get(key);
        if (cached) return { matches: cached.matches };
        // The same search already asked (a repeated Enter, or the phone retrying): share it.
        if (!this.running.has(key)) {
            this.running.set(key, this.ask(buildPrompt(ordered, normalized), ordered)
                .then(matches => { this.remember(key, matches); return matches; })
                .finally(() => this.running.delete(key)));
        }
        return { matches: await this.running.get(key) };
    }

    /** The main model, else the fallback; a model known to be down is not asked. */
    async ask(prompt, ordered) {
        let failure = new ModelUnavailable('No search model is available');
        for (const model of this.models) {
            if (this.known(model) === false) continue;
            try {
                const matches = parseReply(await model.ask(prompt, { timeout: SEARCH_TIMEOUT }), ordered);
                this.mark(model, true);
                return matches;
            } catch (error) {
                // A bad reply says nothing about the model being up; anything else takes it down.
                if (!(error instanceof ReplyError)) this.mark(model, false, error.retryAt);
                failure = error;
            }
        }
        throw failure;
    }

    remember(key, matches) {
        this.cache.delete(key);
        this.cache.set(key, { matches, at: this.now() });
        while (this.cache.size > CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value);
        try { durableWrite(this.cacheFile, JSON.stringify([...this.cache])); }
        catch (error) { console.error('Search cache not saved:', error.message); }
    }
}

/**
 * The local OpenCode server (manga-search-opencode.service), used the way OpenCode's own clients
 * use it: one short session per question, with the tool-less `answer` agent and every
 * permission denied, deleted afterwards.
 */
export class OpencodeModel {
    /** `password`: the server's password, or a function that reads it when asked. */
    constructor({ name, model, url = OPENCODE_URL, password, directory, fetch = globalThis.fetch }) {
        this.name = name; this.url = url; this.directory = directory; this.model = model; this.fetch = fetch;
        this.password = typeof password === 'function' ? password : () => password;
    }

    async call(method, route, body, signal) {
        const password = this.password();
        if (!password) throw new ModelUnavailable('The search OpenCode server is not set up');
        const response = await this.fetch(this.url + route, {
            method, signal, body: body === undefined ? undefined : JSON.stringify(body),
            headers: { Authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64'), 'Content-Type': 'application/json' },
        });
        const text = await response.text();
        if (!response.ok) throw new ModelUnavailable(`OpenCode ${method} ${route}: ${response.status}`);
        return text ? JSON.parse(text) : null;
    }

    async ask(text, { timeout }) {
        const signal = AbortSignal.timeout(timeout);
        let session;
        try {
            session = (await this.call('POST', '/api/session', {
                agent: 'answer', title: 'manga search', model: this.model, location: { directory: this.directory },
                permissions: [{ action: '*', resource: '*', effect: 'deny' }],
            }, signal)).data.id;
            await this.call('POST', `/api/session/${session}/prompt`, { text }, signal);
            await this.call('POST', `/api/experimental/session/${session}/wait`, undefined, signal);
            const messages = (await this.call('GET', `/api/session/${session}/message`, undefined, signal)).data;
            let reply = '', failure = null;
            for (const message of Array.isArray(messages) ? messages : messages?.items ?? []) {
                if (message.type !== 'assistant') continue;
                for (const part of message.content ?? []) if (part.type === 'text') reply += part.text ?? '';
                if (message.error) failure = message.error;
            }
            if (failure) {
                const retryAt = Number.isFinite(failure.retryAfterMs) ? Date.now() + failure.retryAfterMs : null;
                throw new ModelUnavailable(failure.message || failure.type || 'Model error', retryAt);
            }
            return reply;
        } catch (error) {
            if (session && signal.aborted) await this.call('POST', `/api/session/${session}/interrupt`).catch(() => {});
            throw error instanceof ModelUnavailable ? error : new ModelUnavailable(error.message);
        } finally {
            if (session) await this.call('DELETE', `/api/session/${session}`).catch(() => {});
        }
    }
}

/** The OpenCode server's password (opencode-serve.sh writes it on its first start), read when asked. */
export function readOpencodePassword(root = SEARCH_ROOT) {
    if (process.env.OPENCODE_SERVER_PASSWORD) return process.env.OPENCODE_SERVER_PASSWORD;
    try {
        const line = fs.readFileSync(path.join(root, 'opencode.env'), 'utf8').split('\n').find(l => l.startsWith('OPENCODE_SERVER_PASSWORD='));
        return line?.slice('OPENCODE_SERVER_PASSWORD='.length).trim() || null;
    } catch { return null; }
}

/** SEARCH_MODELS on the local OpenCode server (manga-search-opencode.service). */
export function searchModelsFromEnvironment(root = SEARCH_ROOT) {
    return SEARCH_MODELS.map(({ name, ref }) => new OpencodeModel({ name, model: ref, password: () => readOpencodePassword(root), directory: path.join(root, 'workspace') }));
}
