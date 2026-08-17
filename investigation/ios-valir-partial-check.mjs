#!/usr/bin/env node
// Phone: verify server-partial (percent) resume on valir.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createController, createSession, sleep } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const bundle = await readFile(resolve(root, "dist/manga-reader.user.js"), "utf8");

const controller = createController({
    root,
    name: "manga-reader-stage6",
    connectionTimeoutMs: 60_000,
    commandTimeoutMs: 25_000,
    clientTimeoutMs: 30_000,
    settleMs: 2_000,
});
const session = createSession({ controller, sourceLabel: "manga-reader-stage6.user.js" });

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
        "new Function(source + String.fromCharCode(10) + \"//# sourceURL=manga-reader-stage6.user.js\")();\n",
        "return { injectedBytes: source.length };",
    ];
    return parts.join("");
}

const WAIT_CARDS = String.raw`
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 80; i++) {
        if (document.querySelector(".hs-home-card")) break;
        await wait(250);
    }
    return true;
`;

const log = payload => console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 19), ...payload }));

try {
    await session.connect({
        allowedHosts: ["valirscans.org"],
        controlledCode: `return Boolean(document.querySelector(".hs-home") || document.querySelector(".hs-reader-body"));`,
    });
    await session.navigate("https://valirscans.org/", {
        matches: (candidate, expected) => navigationMatches(candidate.href, expected),
    });
    await sleep(3000);
    const fg = await controller.foregroundClient();
    log({ step: "foreground", client: fg.client.slice(0, 16) });

    await controller.command(fg.client, injectCode("https://valirscans.org/"), { expectResult: false });
    await sleep(2500);
    const fg2 = await controller.foregroundClient();
    await controller.command(fg2.client, WAIT_CARDS);

    const states = await controller.command(fg2.client, String.raw`
        const covers = [...document.querySelectorAll(".hs-home-cover")].slice(0, 30);
        return covers.map(c => ({ resume: c.dataset.resume ?? null, slug: c.dataset.seriesSlug }))
            .filter(c => c.resume === "remote");
    `);
    log({ step: "remote-covers", states });

    if (states.length === 0) {
        log({ step: "no-remote-covers" });
    } else {
        const clicked = await controller.command(fg2.client, String.raw`
            const cover = [...document.querySelectorAll(".hs-home-cover")]
                .find(c => c.dataset.resume === "remote");
            if (!cover) return { clicked: false };
            const slug = cover.dataset.seriesSlug;
            const percent = cover.dataset.remoteResumePercent;
            const chapterId = cover.dataset.remoteResumeChapterId;
            cover.click();
            return { clicked: true, slug, chapterId, percent };
        `);
        log({ step: "remote-cover-click", ...clicked });
        await sleep(6000);
        const fg3 = await controller.foregroundClient();
        log({ step: "landed", href: fg3.href });
    }
} finally {
    await session.cleanup().catch(error => log({ step: "cleanup-warning", error: String(error) }));
    session.close();
}
