#!/usr/bin/env node
// Check whether local tracking saved the current #11 position.
import { createController } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const controller = createController({
    root,
    name: "manga-reader-track-check",
    connectionTimeoutMs: 10_000,
    commandTimeoutMs: 15_000,
    clientTimeoutMs: 10_000,
    settleMs: 500,
});

const log = payload => console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 19), ...payload }));

await controller.ensureServer();
await controller.waitForDebugger();
const fg = await controller.foregroundClient();
log({ step: "connected", href: fg.href });

const CHECK = String.raw`
    const path = location.pathname; // /comics/{slug}/chapter/{n}
    const m = path.match(/^\/comics\/([^/]+)\/chapter\/(\d+)/);
    const routeSlug = m ? m[1] : null;
    const chapterId = m ? m[2] : null;
    // Current visible image per the reader's midpoint convention.
    const midpoint = innerHeight / 2;
    const visible = [...document.querySelectorAll(".hs-reader-img")]
        .filter(img => img.complete && img.naturalWidth > 0)
        .map(img => ({ img, top: img.getBoundingClientRect().top }))
        .filter(item => item.top <= midpoint)
        .sort((a, b) => b.top - a.top)[0];
    const dbEntries = await new Promise(resolve => {
        const open = indexedDB.open("manga-reader-compute");
        open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction("progress", "readonly");
            const all = tx.objectStore("progress").getAll();
            all.onsuccess = () => {
                const entries = (all.result ?? [])
                    .filter(e => e.chapterId === chapterId)
                    .map(e => ({ id: e.id, imageIndex: e.imageIndex, totalImages: e.totalImages, updatedAt: e.updatedAt }));
                resolve(entries);
                db.close();
            };
            all.onerror = () => { resolve([{ error: String(all.error) }]); db.close(); };
        };
        open.onerror = () => resolve([{ error: String(open.error) }]);
    });
    return {
        href: location.href,
        hash: location.hash,
        routeSlug,
        chapterId,
        visibleImage: visible ? visible.img.id : null,
        visibleTop: visible ? Math.round(visible.top) : null,
        dbEntries,
    };
`;
log({ step: "check", result: await controller.command(fg.client, CHECK) });
controller.close();
