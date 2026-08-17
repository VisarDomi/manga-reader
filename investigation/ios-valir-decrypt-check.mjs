#!/usr/bin/env node
// Valir reader with decrypted pages: images must load and show blob: srcs.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createController, createSession, sleep } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const bundle = await readFile(resolve(root, "dist/manga-reader.user.js"), "utf8");

const controller = createController({
    root,
    name: "manga-reader-valir-decrypt",
    connectionTimeoutMs: 60_000,
    commandTimeoutMs: 60_000,
    clientTimeoutMs: 30_000,
    settleMs: 2_000,
});
const session = createSession({ controller, sourceLabel: "manga-reader-valir-decrypt.user.js" });

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
        "new Function(source + String.fromCharCode(10) + \"//# sourceURL=valir-decrypt.user.js\")();\n",
        "return { injectedBytes: source.length };",
    ];
    return parts.join("");
}

const SNAPSHOT = String.raw`
    const images = [...document.querySelectorAll(".hs-reader-img")];
    return {
        t: Date.now(),
        readerBodies: document.querySelectorAll(".hs-reader-body").length,
        chapters: document.querySelectorAll(".hs-chapter").length,
        images: images.length,
        blobSrcs: images.filter(i => i.src.startsWith("blob:")).length,
        loaded: images.filter(i => i.complete && i.naturalWidth > 0).length,
        firstSrc: images[0]?.src.slice(0, 30) ?? null,
        firstLoaded: images[0] ? images[0].complete && images[0].naturalWidth > 0 : false,
        fatal: document.getElementById("hs-fatal-error")?.textContent ?? null,
        status: document.querySelector(".hs-status")?.textContent ?? null,
    };
`;

const log = payload => console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 19), ...payload }));

try {
    await session.connect({
        allowedHosts: ["valirscans.org"],
        controlledCode: `return Boolean(document.querySelector(".hs-home") || document.querySelector(".hs-reader-body"));`,
    });
    const url = "https://valirscans.org/series/comic/my-tyrant-brother-is-a-bonus/chapter/16#2";
    await session.navigate(url, {
        matches: (candidate, expected) => navigationMatches(candidate.href, expected),
    });
    await sleep(3000);
    const fg = await controller.foregroundClient();
    log({ step: "foreground", client: fg.client.slice(0, 16) });

    const start = Date.now();
    await controller.command(fg.client, injectCode(url), { expectResult: false });
    log({ step: "inject-posted", t: Date.now() - start });
    await sleep(5000);
    const fg2 = await controller.foregroundClient();
    log({ step: "snapshot-1", elapsed: Date.now() - start, result: await controller.command(fg2.client, SNAPSHOT) });
    await sleep(8000);
    log({ step: "snapshot-2", elapsed: Date.now() - start, result: await controller.command(fg2.client, SNAPSHOT) });
    await sleep(8000);
    log({ step: "snapshot-3", elapsed: Date.now() - start, result: await controller.command(fg2.client, SNAPSHOT) });
} finally {
    await session.cleanup().catch(error => log({ step: "cleanup-warning", error: String(error) }));
    session.close();
}
