#!/usr/bin/env node
// One-time manual migration: re-key asura progress entries from hex slugs to
// the bare history identity. Runs on the live foreground page's IndexedDB.
import { createController } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const controller = createController({
    root,
    name: "manga-reader-asura-migrate",
    connectionTimeoutMs: 10_000,
    commandTimeoutMs: 30_000,
    clientTimeoutMs: 10_000,
    settleMs: 500,
});

const log = payload => console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 19), ...payload }));

await controller.ensureServer();
await controller.waitForDebugger();
const fg = await controller.foregroundClient();
log({ step: "connected", href: fg.href });

const MIGRATE = String.raw`
    const provider = "asurascans";
    const prefix = provider + String.fromCharCode(0);
    const bare = slug => slug.replace(/-[0-9a-f]{8}$/i, "");
    return await new Promise(resolve => {
        const open = indexedDB.open("manga-reader-compute");
        open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction("progress", "readwrite");
            const store = tx.objectStore("progress");
            const all = store.getAll();
            all.onsuccess = () => {
                const entries = (all.result ?? []).filter(e =>
                    typeof e.id === "string" && e.id.startsWith(prefix));
                const moved = [];
                const merged = [];
                const skipped = [];
                const ops = [];
                for (const entry of entries) {
                    const rest = entry.id.slice(prefix.length);
                    const sep = rest.lastIndexOf(String.fromCharCode(0));
                    if (sep === -1) { skipped.push(entry.id); continue; }
                    const slug = rest.slice(0, sep);
                    const chapterId = rest.slice(sep + 1);
                    const bareSlug = bare(slug);
                    if (bareSlug === slug) continue;
                    const newId = prefix + bareSlug + String.fromCharCode(0) + chapterId;
                    const newEntry = { ...entry, id: newId, seriesSlug: bareSlug };
                    const existing = entries.find(e => e.id === newId);
                    if (existing) {
                        if ((existing.updatedAt ?? 0) >= (entry.updatedAt ?? 0)) {
                            ops.push(store.delete(entry.id));
                            merged.push(entry.id + " -> " + newId + " (kept newer)");
                        } else {
                            ops.push(store.put(newEntry));
                            ops.push(store.delete(entry.id));
                            merged.push(entry.id + " -> " + newId + " (old was newer)");
                        }
                    } else {
                        ops.push(store.put(newEntry));
                        ops.push(store.delete(entry.id));
                        moved.push(entry.id + " -> " + newId);
                    }
                }
                tx.oncomplete = () => {
                    resolve({ total: entries.length, moved, merged, skipped });
                    db.close();
                };
                tx.onerror = () => { resolve({ error: String(tx.error) }); db.close(); };
            };
            all.onerror = () => { resolve({ error: String(all.error) }); db.close(); };
        };
        open.onerror = () => resolve({ error: String(open.error) });
    });
`;
log({ step: "migrate", result: await controller.command(fg.client, MIGRATE) });
controller.close();
