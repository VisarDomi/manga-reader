#!/usr/bin/env node
// Read chapter 18 (newer than the server's highest) partway and check the
// server's resume picks up the percentage.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createController, createSession, sleep } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const bundle = await readFile(resolve(root, "dist/manga-reader.user.js"), "utf8");
const URL18 = "https://valirscans.org/series/comic/my-tyrant-brother-is-a-bonus/chapter/18";

const controller = createController({
    root,
    name: "manga-reader-valir-18",
    connectionTimeoutMs: 60_000,
    commandTimeoutMs: 45_000,
    clientTimeoutMs: 30_000,
    settleMs: 2_000,
});
const session = createSession({ controller, sourceLabel: "manga-reader-valir-18.user.js" });

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
        "new Function(source + String.fromCharCode(10) + \"//# sourceURL=valir-18.user.js\")();\n",
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
    await session.navigate(URL18, { matches: (candidate, expected) => navigationMatches(candidate.href, expected) });
    await sleep(3000);
    const fg = await controller.foregroundClient();
    await controller.command(fg.client, injectCode(URL18), { expectResult: false });
    await sleep(12000);
    const fg2 = await controller.foregroundClient();

    const scroll = await controller.command(fg2.client, String.raw`
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const reader = !!document.querySelector(".hs-reader-body");
        const settled = new Promise(resolve => addEventListener("scrollend", resolve, { once: true }));
        scrollTo(0, scrollY + 700);
        await Promise.race([settled, wait(3000)]);
        await wait(1500);
        return { reader, href: location.href, syncError: document.querySelector(".hs-error")?.textContent ?? null };
    `);
    log({ step: "scroll", scroll });
    await sleep(3000);

    const cr = await controller.command(fg2.client, String.raw`
        const res = await fetch("/api/continue-reading", { credentials: "same-origin", cache: "no-store" });
        const json = await res.json().catch(() => null);
        const series = json && Array.isArray(json.series)
            ? json.series.find(s => s.urlSlug === "my-tyrant-brother-is-a-bonus" || s.slug === "my-tyrant-brother-is-a-bonus")
            : null;
        return series ? { lastChapter: series.lastChapter, highestChapter: series.highestChapter } : null;
    `);
    log({ step: "continue-reading", cr });
} finally {
    await session.cleanup().catch(error => log({ step: "cleanup-warning", error: String(error) }));
    session.close();
}
