#!/usr/bin/env node
// Phone: verify chapter-link click — server-read chapter -> last image.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createController, createSession, sleep } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const bundle = await readFile(resolve(root, "dist/manga-reader.user.js"), "utf8");

const controller = createController({
    root,
    name: "manga-reader-stage5",
    connectionTimeoutMs: 60_000,
    commandTimeoutMs: 25_000,
    clientTimeoutMs: 30_000,
    settleMs: 2_000,
});
const session = createSession({ controller, sourceLabel: "manga-reader-stage5.user.js" });

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
        "new Function(source + String.fromCharCode(10) + \"//# sourceURL=manga-reader-stage5.user.js\")();\n",
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
        allowedHosts: ["asurascans.com"],
        controlledCode: `return Boolean(document.querySelector(".hs-home") || document.querySelector(".hs-reader-body"));`,
    });
    await session.navigate("https://asurascans.com/", {
        matches: (candidate, expected) => navigationMatches(candidate.href, expected),
    });
    await sleep(3000);
    const fg = await controller.foregroundClient();
    log({ step: "foreground", client: fg.client.slice(0, 16) });

    await controller.command(fg.client, injectCode("https://asurascans.com/"), { expectResult: false });
    await sleep(2500);
    const fg2 = await controller.foregroundClient();
    await controller.command(fg2.client, WAIT_CARDS);

    const picked = await controller.command(fg2.client, String.raw`
        // A server-read chapter link: read class, no hash (no local page).
        const link = [...document.querySelectorAll(".hs-home-chapter")]
            .find(l => l.classList.contains("hs-home-chapter-read") && !l.hash);
        if (!link) return { clicked: false };
        link.click();
        return {
            clicked: true,
            series: link.dataset.seriesSlug,
            chapterId: link.dataset.chapterId,
            fromHref: link.getAttribute("href"),
        };
    `);
    log({ step: "chapter-click", ...picked });

    await sleep(6000);
    const fg3 = await controller.foregroundClient();
    log({ step: "after-click-foreground", href: fg3.href });
    const reader = await controller.command(fg3.client, String.raw`
        return { href: location.href };
    `);
    log({ step: "landed", reader });
} finally {
    await session.cleanup().catch(error => log({ step: "cleanup-warning", error: String(error) }));
    session.close();
}
