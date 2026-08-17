#!/usr/bin/env node
// Stage 3 v2: full-control flow. Clear every site timer, then inject
// fire-and-forget, then poll the takeover DOM directly.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createController, createSession, sleep } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const bundle = await readFile(resolve(root, "dist/manga-reader.user.js"), "utf8");

const controller = createController({
    root,
    name: "manga-reader-stage3",
    connectionTimeoutMs: 60_000,
    commandTimeoutMs: 30_000,
    clientTimeoutMs: 30_000,
    settleMs: 2_000,
});
const session = createSession({
    controller,
    sourceLabel: "manga-reader-stage3.user.js",
});

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
        "new Function(source + String.fromCharCode(10) + \"//# sourceURL=manga-reader-stage3.user.js\")();\n",
        "return { injectedBytes: source.length };",
    ];
    return parts.join("");
}

const SWEEP_TIMERS = String.raw`
    // Kill every pending site timer/interval: the site schedules a reload
    // that survives document.open() and would wipe the takeover.
    for (let i = 1; i < 100000; i++) { clearTimeout(i); clearInterval(i); }
    window.onbeforeunload = () => false;
    return true;
`;

const SNAPSHOT = String.raw`
    const covers = [...document.querySelectorAll(".hs-home-card .hs-home-cover")];
    return {
        cards: document.querySelectorAll(".hs-home-card").length,
        coversWithResume: covers.filter(c => c.dataset.resume !== undefined).length,
        readChapters: document.querySelectorAll(".hs-home-chapter-read").length,
        statusText: document.querySelector(".hs-home-catalog-status")?.textContent ?? null,
        homeError: document.querySelector(".hs-home-error")?.textContent ?? null,
        scrollY: Math.round(window.scrollY),
    };
`;

const WAIT_CARDS = String.raw`
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 60; i++) {
        if (document.querySelector(".hs-home-card")) break;
        await wait(250);
    }
    return true;
`;

const SCROLL_ONCE = String.raw`
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const settled = new Promise(resolve => addEventListener("scrollend", resolve, { once: true }));
    scrollTo(0, scrollY + 600);
    await Promise.race([settled, wait(2000)]);
    await wait(250);
    return true;
`;

const log = payload => console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 19), ...payload }));

try {
    log({ step: "connect-start" });
    await session.connect({
        allowedHosts: ["asurascans.com"],
        controlledCode: `return Boolean(document.querySelector(".hs-home") || document.querySelector(".hs-reader-body"));`,
    });
    log({ step: "connect-done" });

    const url = "https://asurascans.com/";
    log({ step: "navigate-start" });
    await session.navigate(url, { matches: (candidate, expected) => navigationMatches(candidate.href, expected) });
    await sleep(3000);
    const fg = await controller.foregroundClient();
    log({ step: "foreground", client: fg.client.slice(0, 16), href: fg.href });

    // Fire-and-forget: the takeover kills the command's reply; we poll the
    // DOM instead of waiting for a result.
    log({ step: "inject-fire-forget" });
    await controller.command(fg.client, injectCode(url), { expectResult: false });

    await sleep(2000);
    const fg2 = await controller.foregroundClient();
    log({ step: "post-inject-foreground", client: fg2.client.slice(0, 16), href: fg2.href });

    await controller.command(fg2.client, WAIT_CARDS);
    log({ step: "snapshot-1", result: await controller.command(fg2.client, SNAPSHOT) });

    for (const round of [2, 3, 4]) {
        await controller.command(fg2.client, SCROLL_ONCE);
        log({ step: "snapshot-" + round, result: await controller.command(fg2.client, SNAPSHOT) });
    }
} finally {
    await session.cleanup().catch(error => log({ step: "cleanup-warning", error: String(error) }));
    session.close();
}
