#!/usr/bin/env node
// Verify: no asura hex-slug keys remain; bare keys exist.
import { createController } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const controller = createController({
    root,
    name: "manga-reader-asura-verify",
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

const VERIFY = String.raw`
    return await new Promise(resolve => {
        const open = indexedDB.open("manga-reader-compute");
        open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction("progress", "readonly");
            const all = tx.objectStore("progress").getAllKeys();
            all.onsuccess = () => {
                const keys = (all.result ?? []).filter(k => String(k).startsWith("asurascans" + String.fromCharCode(0)));
                const hexKeys = keys.filter(k => {
                    const rest = String(k).slice("asurascans".length + 1);
                    const slug = rest.slice(0, rest.lastIndexOf(String.fromCharCode(0)));
                    return /-[0-9a-f]{8}$/i.test(slug);
                });
                resolve({ asuraKeys: keys.length, hexKeysRemaining: hexKeys.length, hexSamples: hexKeys.slice(0, 5) });
                db.close();
            };
            all.onerror = () => { resolve({ error: String(all.error) }); db.close(); };
        };
        open.onerror = () => resolve({ error: String(open.error) });
    });
`;
log({ step: "verify", result: await controller.command(fg.client, VERIFY) });
controller.close();
