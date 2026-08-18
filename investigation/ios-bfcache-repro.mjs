#!/usr/bin/env node
// Reproduce the stale overlay on the bfcache-revived home: dispatch pageshow
// and watch whether the cover/link re-resolve and whether an error appears.
import { createController } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const controller = createController({
    root,
    name: "manga-reader-bfcache-repro",
    connectionTimeoutMs: 10_000,
    commandTimeoutMs: 20_000,
    clientTimeoutMs: 10_000,
    settleMs: 500,
});

const log = payload => console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 19), ...payload }));

await controller.ensureServer();
await controller.waitForDebugger();
const fg = await controller.foregroundClient();
log({ step: "connected", href: fg.href });

const REPRO = String.raw`
    const read = () => {
        const link = [...document.querySelectorAll(".hs-home-chapter")].find(el => el.dataset.seriesSlug?.includes("absolute-regression") && el.dataset.chapterId === "114");
        const cover = [...document.querySelectorAll(".hs-home-cover")].find(el => el.dataset.seriesSlug?.includes("absolute-regression"));
        return {
            link: link ? link.getAttribute("href") : null,
            cover: cover ? cover.getAttribute("href") : null,
            historyError: document.querySelector(".hs-history-notice, .hs-status.hs-error, [data-history-error]")?.textContent ?? null,
            allStatuses: [...document.querySelectorAll(".hs-status")].map(el => el.textContent),
        };
    };
    const before = read();
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    window.dispatchEvent(new Event("pageshow"));
    await wait(2500);
    const after = read();
    return { before, after, persistedEvents: "dispatched pageshow manually" };
`;
log({ step: "repro", result: await controller.command(fg.client, REPRO) });
controller.close();
