#!/usr/bin/env node
// Violet home live poll: does the catalog loop progress or hang?
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createController, createSession, sleep } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const bundle = await readFile(resolve(root, "dist/manga-reader.user.js"), "utf8");

const controller = createController({
    root,
    name: "manga-reader-violet-home",
    connectionTimeoutMs: 60_000,
    commandTimeoutMs: 30_000,
    clientTimeoutMs: 30_000,
    settleMs: 2_000,
});
const session = createSession({ controller, sourceLabel: "manga-reader-violet-home.user.js" });

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
        "new Function(source + String.fromCharCode(10) + \"//# sourceURL=violet-home.user.js\")();\n",
        "return { injectedBytes: source.length };",
    ];
    return parts.join("");
}

const POLL = String.raw`
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const samples = [];
    for (let i = 0; i < 30; i++) {
        samples.push({
            t: i * 2,
            cards: document.querySelectorAll(".hs-home-card").length,
            status: document.querySelector(".hs-home-catalog-status")?.textContent ?? null,
            error: document.querySelector(".hs-home-error")?.textContent ?? null,
        });
        const settled = new Promise(resolve => addEventListener("scrollend", resolve, { once: true }));
        scrollTo(0, document.documentElement.scrollHeight);
        await Promise.race([settled, wait(1000)]);
        await wait(1000);
    }
    return samples;
`;

const log = payload => console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 19), ...payload }));

try {
    await session.connect({
        allowedHosts: ["violetscans.org"],
        controlledCode: `return Boolean(document.querySelector(".hs-home") || document.querySelector(".hs-reader-body"));`,
    });
    await session.navigate("https://violetscans.org/", { matches: (candidate, expected) => navigationMatches(candidate.href, expected) });
    const fg = await controller.foregroundClient();
    await controller.command(fg.client, injectCode("https://violetscans.org/"), { expectResult: false });
    await sleep(2500);
    const fg2 = await controller.foregroundClient();
    log({ step: "poll", result: await controller.command(fg2.client, POLL) });
} finally {
    await session.cleanup().catch(error => log({ step: "cleanup-warning", error: String(error) }));
    session.close();
}
