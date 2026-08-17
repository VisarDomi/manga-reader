#!/usr/bin/env node
// Acceptance: inject the real bundle on the phone and verify the worker
// pipeline end-to-end: takeover, worker-fed history pass, worker save to IDB.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createController, createSession } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const bundle = await readFile(resolve(root, "dist/manga-reader.user.js"), "utf8");

const controller = createController({
    root,
    name: "manga-reader-acceptance",
    connectionTimeoutMs: 60_000,
    commandTimeoutMs: 60_000,
    clientTimeoutMs: 30_000,
});
const session = createSession({
    controller,
    sourceLabel: "manga-reader-acceptance.user.js",
});

function injectCode(url) {
    const parts = [
        "history.replaceState(null, \"\", " + JSON.stringify(url) + ");\n",
        "const source = " + JSON.stringify(bundle) + ";\n",
        "new Function(source + String.fromCharCode(10) + \"//# sourceURL=manga-reader-acceptance.user.js\")();\n",
        "return { injectedBytes: source.length };",
    ];
    return parts.join("");
}

const WAIT_HOME = String.raw`
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 120; i++) {
        const cards = document.querySelectorAll(".hs-home-card");
        if (cards.length > 0) {
            return {
                ok: true,
                cards: cards.length,
                overlayApplied: cards[0].querySelector(".hs-home-cover")?.dataset.resume !== undefined,
            };
        }
        await wait(250);
    }
    return { ok: false, cards: 0 };
`;

const READER_FLOW = String.raw`
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 120 && !document.querySelector(".hs-reader-body"); i++) await wait(250);
    const first = document.querySelector(".hs-reader-img");
    if (!first) return { error: "no reader image" };
    for (let i = 0; i < 240 && !(first.complete && first.naturalWidth > 0); i++) await wait(250);
    // natural scroll so scrollend fires and the tracker saves through the worker
    const settled = new Promise(resolve => addEventListener("scrollend", resolve, { once: true }));
    scrollTo(0, (first.offsetTop + first.offsetHeight / 2));
    await Promise.race([settled, wait(3000)]);
    await wait(500);
    const idb = await new Promise((resolve, reject) => {
        const q = indexedDB.open("manga-reader-compute", 1);
        q.onsuccess = () => {
            const db = q.result;
            const tx = db.transaction("progress", "readonly");
            const r = tx.objectStore("progress").getAll();
            r.onsuccess = () => { db.close(); resolve(r.result); };
            r.onerror = () => reject(r.error);
        };
        q.onerror = () => reject(q.error);
    });
    return {
        href: location.href,
        legacyKeyPresent: localStorage.getItem("manga-reader-progress-v1") !== null,
        idbEntries: idb.length,
        savedEntry: idb.filter(e => e.chapterId === "50" && e.seriesSlug === "chronicles-of-the-lazy-sovereign").length > 0,
    };
`;

const log = payload => console.log(JSON.stringify(payload));

try {
    await session.connect({
        allowedHosts: ["asurascans.com", "valirscans.org"],
        controlledCode: `return Boolean(document.querySelector(".hs-home") || document.querySelector(".hs-reader-body"));`,
    });
    log({ step: "connected" });

    // 1. asura home: takeover + worker-fed overlay
    const asuraHome = "https://asurascans.com/";
    log({ step: "navigating", site: "asura-home" });
    await session.navigate(asuraHome);
    await session.reload();
    await session.command(injectCode(asuraHome), { expectResult: false });
    log({ step: "asura-home", result: await session.command(WAIT_HOME) });

    // 2. asura reader: scroll → worker save → IDB entry
    const asuraReader = "https://asurascans.com/comics/chronicles-of-the-lazy-sovereign-f886a8af/chapter/50#3";
    log({ step: "navigating", site: "asura-reader" });
    await session.navigate(asuraReader);
    await session.reload();
    await session.command(injectCode(asuraReader), { expectResult: false });
    log({ step: "asura-reader", result: await session.command(READER_FLOW) });

    // 3. valir home: takeover on the strict-CSP site (worker in real flow)
    const valirHome = "https://valirscans.org/";
    log({ step: "navigating", site: "valir-home" });
    await session.navigate(valirHome);
    await session.reload();
    await session.command(injectCode(valirHome), { expectResult: false });
    log({ step: "valir-home", result: await session.command(WAIT_HOME) });
} finally {
    await session.cleanup().catch(error => log({ step: "cleanup-warning", error: String(error) }));
    session.close();
}
