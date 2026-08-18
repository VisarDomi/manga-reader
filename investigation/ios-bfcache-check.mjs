#!/usr/bin/env node
// After swipe-back (bfcache): home status, IDB, and the cover/link sync state.
import { createController } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const controller = createController({
    root,
    name: "manga-reader-bfcache-check",
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
    const link = [...document.querySelectorAll(".hs-home-chapter")].find(el => el.dataset.seriesSlug?.includes("absolute-regression") && el.dataset.chapterId === "114");
    const cover = [...document.querySelectorAll(".hs-home-cover")].find(el => el.dataset.seriesSlug?.includes("absolute-regression"));
    const dbEntry = await new Promise(resolve => {
        const open = indexedDB.open("manga-reader-compute");
        open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction("progress", "readonly");
            const all = tx.objectStore("progress").getAll();
            all.onsuccess = () => {
                const entries = (all.result ?? [])
                    .filter(e => e.chapterId === "114")
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
        hasHome: !!document.querySelector(".hs-home"),
        cards: document.querySelectorAll(".hs-home-card").length,
        status: document.querySelector(".hs-home-catalog-status")?.textContent ?? null,
        fatal: document.getElementById("hs-fatal-error")?.textContent ?? null,
        link: link ? {
            classes: [...link.classList],
            href: link.getAttribute("href"),
            remotePercent: link.dataset.remoteResumePercent ?? null,
        } : null,
        cover: cover ? {
            slug: cover.dataset.seriesSlug,
            resume: cover.dataset.resume ?? null,
            href: cover.getAttribute("href"),
        } : null,
        dbEntry,
    };
`;
log({ step: "check", result: await controller.command(fg.client, CHECK) });
controller.close();
