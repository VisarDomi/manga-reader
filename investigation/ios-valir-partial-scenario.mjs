#!/usr/bin/env node
// Valir partial scenario:
//  A. read part of chapter 16 -> local partial + server percent saved
//  B. valir home: cover shows LOCAL (local trumps server)
//  C. delete the local progress entry (worker IDB)
//  D. reload home: cover shows REMOTE; click it -> percent -> page index
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createController, createSession, sleep } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const bundle = await readFile(resolve(root, "dist/manga-reader.user.js"), "utf8");
const CHAPTER_URL = "https://valirscans.org/series/comic/my-tyrant-brother-is-a-bonus/chapter/18";
const SLUG = "my-tyrant-brother-is-a-bonus";

const controller = createController({
    root,
    name: "manga-reader-valir-partial",
    connectionTimeoutMs: 60_000,
    commandTimeoutMs: 45_000,
    clientTimeoutMs: 30_000,
    settleMs: 2_000,
});
const session = createSession({ controller, sourceLabel: "manga-reader-valir-partial.user.js" });

function navigationMatches(actualUrl, expectedUrl) {
    if (actualUrl === expectedUrl) return true;
    try {
        const actual = new URL(actualUrl);
        const expected = new URL(expectedUrl);
        const actualTail = actual.pathname.split("/").filter(Boolean).slice(-2).join("/");
        const expectedTail = expected.pathname.split("/").filter(Boolean).slice(-2).join("/");
        return (
            actual.hostname === expected.hostname &&
            actualTail === expectedTail &&
            actual.hash === expected.hash
        );
    } catch {
        return false;
    }
}

function injectCode(url) {
    const parts = [
        "history.replaceState(null, \"\", " + JSON.stringify(url) + ");\n",
        "const source = " + JSON.stringify(bundle) + ";\n",
        "new Function(source + String.fromCharCode(10) + \"//# sourceURL=valir-partial.user.js\")();\n",
        "return { injectedBytes: source.length };",
    ];
    return parts.join("");
}

const log = payload => console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 19), ...payload }));

try {
    await session.connect({
        allowedHosts: ["valirscans.org"],
        controlledCode: `return Boolean(document.querySelector(".hs-home") || document.querySelector(".hs-reader-body"));`,
    });

    // A. read part of chapter 16.
    await session.navigate(CHAPTER_URL, { matches: (candidate, expected) => navigationMatches(candidate.href, expected) });
    await sleep(3000);
    const fg = await controller.foregroundClient();
    await controller.command(fg.client, injectCode(CHAPTER_URL), { expectResult: false });
    await sleep(12000);
    const fg2 = await controller.foregroundClient();
    const read = await controller.command(fg2.client, String.raw`
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        // Scroll to image #5 so the reader saves a partial position.
        const target = document.getElementById("#5");
        if (!target) return { error: "image #5 not rendered" };
        const settled = new Promise(resolve => addEventListener("scrollend", resolve, { once: true }));
        scrollTo(0, target.offsetTop);
        await Promise.race([settled, wait(3000)]);
        await wait(1000);
        return { href: location.href, hash: location.hash };
    `);
    log({ step: "A-read", read });

    // B. valir home: the cover must resolve LOCAL.
    await session.navigate("https://valirscans.org/", { matches: (candidate, expected) => navigationMatches(candidate.href, expected) });
    await sleep(3000);
    const fgB = await controller.foregroundClient();
    await controller.command(fgB.client, injectCode("https://valirscans.org/"), { expectResult: false });
    await sleep(15000);
    const cover = await controller.command(fgB.client, String.raw`
        const c = [...document.querySelectorAll(".hs-home-cover")].find(el => el.dataset.seriesSlug === "my-tyrant-brother-is-a-bonus");
        return c ? { resume: c.dataset.resume, href: c.getAttribute("href") } : null;
    `);
    log({ step: "B-local-cover", cover });

    // C. delete the local progress entry for chapter 16.
    const deleted = await controller.command(fgB.client, String.raw`
        const prefix = "valirscans" + String.fromCharCode(0) + "my-tyrant-brother-is-a-bonus" + String.fromCharCode(0);
        return await new Promise(resolve => {
            const open = indexedDB.open("manga-reader-compute");
            open.onsuccess = () => {
                const db = open.result;
                const tx = db.transaction("progress", "readwrite");
                const store = tx.objectStore("progress");
                const all = store.getAllKeys();
                all.onsuccess = () => {
                    const keys = (all.result ?? []).filter(k => k.startsWith(prefix));
                    const dels = keys.map(key => new Promise(ok => {
                        const del = store.delete(key);
                        del.onsuccess = () => ok(true);
                        del.onerror = () => ok(false);
                    }));
                    Promise.all(dels).then(results => {
                        resolve({ deleted: results.length, keys });
                        db.close();
                    });
                };
                all.onerror = () => { resolve({ deleted: 0, error: String(all.error) }); db.close(); };
            };
            open.onerror = () => resolve({ deleted: 0, error: String(open.error) });
        });
    `);
    log({ step: "C-delete-local", deleted });

    // D. reload the home (fresh resolve) and inspect the cover again.
    await session.reload("https://valirscans.org/", { matches: (candidate, expected) => navigationMatches(candidate.href, expected) });
    await sleep(3000);
    const fgD = await controller.foregroundClient();
    await controller.command(fgD.client, injectCode("https://valirscans.org/"), { expectResult: false });
    await sleep(15000);
    const cover2 = await controller.command(fgD.client, String.raw`
        const c = [...document.querySelectorAll(".hs-home-cover")].find(el => el.dataset.seriesSlug === "my-tyrant-brother-is-a-bonus");
        return c ? { resume: c.dataset.resume, href: c.getAttribute("href"), remoteChapter: c.dataset.remoteResumeChapterId ?? null, remotePercent: c.dataset.remoteResumePercent ?? null } : null;
    `);
    log({ step: "D-remote-cover", cover2 });

    // Click the cover: the percent path resolves an image index.
    if (cover2 && cover2.resume === "remote") {
        const clicked = await controller.command(fgD.client, String.raw`
            const c = [...document.querySelectorAll(".hs-home-cover")].find(el => el.dataset.seriesSlug === "my-tyrant-brother-is-a-bonus");
            if (!c) return { clicked: false };
            c.click();
            return { clicked: true };
        `);
        log({ step: "D-click", clicked });
        await sleep(8000);
        const fgE = await controller.foregroundClient();
        log({ step: "D-landed", href: fgE.href });
    }
} finally {
    await session.cleanup().catch(error => log({ step: "cleanup-warning", error: String(error) }));
    session.close();
}
