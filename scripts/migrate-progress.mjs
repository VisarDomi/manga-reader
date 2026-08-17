#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// ONE-SHOT legacy progress migration for the iPhone.
//
//   node scripts/migrate-progress.mjs
//
// What it does: for every provider domain, copies the old
// `manga-reader-progress-v1` localStorage string into the new worker-owned
// IndexedDB (database "manga-reader-compute" v1, store "progress", keyPath "id" —
// must match src/core/compute/store.ts), then deletes the legacy key.
//
// Requirements:
//   - iPhone unlocked, Safari foregrounded on https://example.com/
//   - the production manga-reader userscript DISABLED (it already is)
//   - the universal debugger userscript enabled (it already is)
//
// After every site reports migrated/skipped, DELETE THIS FILE.
//
// Desktop note: desktop Chrome/Tampermonkey keeps the same legacy key per site
// in the desktop browser. Migration there is the same copy, run once per site
// from the console while the production userscript is disabled:
//
//   (() => { const k='manga-reader-progress-v1'; const raw=localStorage.getItem(k);
//   if(!raw) return 'nothing'; const e=JSON.parse(raw);
//   const q=indexedDB.open('manga-reader-compute',1);
//   q.onupgradeneeded=()=>{ if(!q.result.objectStoreNames.contains('progress'))
//   q.result.createObjectStore('progress',{keyPath:'id'}); };
//   q.onsuccess=()=>{ const t=q.result.transaction('progress','readwrite',
//   {durability:'strict'}); const s=t.objectStore('progress');
//   e.forEach(x=>s.put(x)); t.oncomplete=()=>{ q.result.close();
//   localStorage.removeItem(k); console.log('migrated '+e.length); }; }; })();
// ─────────────────────────────────────────────────────────────────────────────
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
    createController,
    createSession,
    phaseBannerScript,
} from "userscript-ios-test/controller";

const root = resolve(import.meta.dirname, "..");
const sitesConfig = JSON.parse(
    await readFile(resolve(root, "src/core/sites.json"), "utf8"),
);
const domains = Object.values(sitesConfig).map(site => site.domain);

const controller = createController({
    root,
    name: "manga-reader-progress-migration",
    connectionTimeoutMs: 60_000,
    commandTimeoutMs: 45_000,
    clientTimeoutMs: 30_000,
});
const session = createSession({
    controller,
    sourceLabel: "manga-reader-progress-migration.user.js",
});

const MIGRATE = String.raw`
    const KEY = "manga-reader-progress-v1";
    const DB = "manga-reader-compute";
    const STORE = "progress";
    const raw = localStorage.getItem(KEY);
    if (raw === null) return { status: "skipped", count: 0 };
    let entries;
    try {
        entries = JSON.parse(raw);
    } catch (error) {
        return { status: "error", error: "legacy store is not valid JSON: " + String(error) };
    }
    if (!Array.isArray(entries)) {
        return { status: "error", error: "legacy store is not an array; key left untouched" };
    }
    await new Promise((resolve, reject) => {
        const request = indexedDB.open(DB, 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: "id" });
            }
        };
        request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction(STORE, "readwrite", { durability: "strict" });
            const store = tx.objectStore(STORE);
            for (const entry of entries) store.put(entry);
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => reject(tx.error ?? new Error("transaction failed"));
            tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
        };
        request.onerror = () => reject(request.error ?? new Error("open failed"));
    });
    localStorage.removeItem(KEY);
    return { status: "migrated", count: entries.length };
`;

const log = payload => console.log(JSON.stringify(payload));

try {
    await session.connect({
        allowedHosts: domains,
        controlledCode: `return Boolean(
            document.querySelector(".hs-home") ||
            document.querySelector(".hs-reader-body")
        );`,
    });
    log({ step: "connected" });

    const results = [];
    for (const domain of domains) {
        const url = `https://${domain}/`;
        log({ step: "navigating", domain });
        await session.navigate(url);
        await session.reload();
        await session.command(
            phaseBannerScript({
                globalName: "__migratePhase",
                elementId: "__migrate-phase",
            }) + ` globalThis.__migratePhase?.("Migrating ${domain}…"); return true;`,
        );
        const result = await session.command(MIGRATE);
        results.push({ domain, ...result });
        log({ step: "site-done", domain, result });
        const banner = result.status === "migrated"
            ? `Migrated ${result.count} entries`
            : result.status === "skipped"
                ? "Nothing to migrate"
                : `FAILED: ${result.error}`;
        await session.showPhase({
            globalName: "__migratePhase",
            text: banner,
            state: result.status === "migrated" || result.status === "skipped" ? "success" : "error",
            pauseMs: 800,
        }).catch(() => {});
    }

    log({ step: "complete", results });
    const migrated = results.filter(result => result.status === "migrated").reduce((sum, result) => sum + result.count, 0);
    console.log(`
Migration complete: ${migrated} entries copied across ${results.filter(result => result.status === "migrated").length} site(s).`);
    console.log("Delete scripts/migrate-progress.mjs when you are satisfied.");
} finally {
    await session.cleanup().catch(error => log({ step: "cleanup-warning", error: String(error) }));
    session.close();
}
