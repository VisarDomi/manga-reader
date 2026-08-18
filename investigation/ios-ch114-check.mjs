#!/usr/bin/env node
// Cross-check the chapter-114 partial state on the live page against the
// app's IndexedDB progress entry.
import { createController } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const controller = createController({
    root,
    name: "manga-reader-ch114-check",
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
    // 1. The chapter-114 link as rendered.
    const link = [...document.querySelectorAll(".hs-home-chapter")].find(el => el.dataset.chapterId === "114");
    const cover = [...document.querySelectorAll(".hs-home-cover")].find(el => el.dataset.seriesSlug && el.closest(".hs-home-card")?.querySelector('.hs-home-chapter[data-chapter-id="114"]'));
    const linkState = link ? {
        series: link.dataset.seriesSlug,
        classes: [...link.classList],
        href: link.getAttribute("href"),
        remotePercent: link.dataset.remoteResumePercent ?? null,
    } : null;
    const coverState = cover ? {
        series: cover.dataset.seriesSlug,
        resume: cover.dataset.resume ?? null,
        href: cover.getAttribute("href"),
        remotePercent: cover.dataset.remoteResumePercent ?? null,
        remoteChapter: cover.dataset.remoteResumeChapterId ?? null,
    } : null;

    // 2. The app's own IndexedDB progress for chapter 114 of this series.
    const dbEntries = await new Promise(resolve => {
        const open = indexedDB.open("manga-reader-compute");
        open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction("progress", "readonly");
            const req = tx.objectStore("progress").getAll();
            req.onsuccess = () => {
                const entries = (req.result ?? []).filter(e => e.chapterId === "114");
                resolve(entries.map(e => ({ id: e.id, imageIndex: e.imageIndex, totalImages: e.totalImages, updatedAt: e.updatedAt })));
                db.close();
            };
            req.onerror = () => { resolve([{ error: String(req.error) }]); db.close(); };
        };
        open.onerror = () => resolve([{ error: String(open.error) }]);
    });

    return { href: location.href, linkState, coverState, dbEntries };
`;
log({ step: "check", result: await controller.command(fg.client, CHECK) });
controller.close();
