#!/usr/bin/env node
// Stepwise decrypt debug on the phone: find the failing stage.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createController, createSession, sleep } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const bundle = await readFile(resolve(root, "dist/manga-reader.user.js"), "utf8");

const controller = createController({
    root,
    name: "manga-reader-valir-step-debug",
    connectionTimeoutMs: 60_000,
    commandTimeoutMs: 40_000,
    clientTimeoutMs: 30_000,
    settleMs: 2_000,
});
const session = createSession({ controller, sourceLabel: "manga-reader-valir-step-debug.user.js" });

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

const STEPS = String.raw`
    const out = {};
    const b64 = v => {
        const bytes = Uint8Array.from(atob(v), c => c.charCodeAt(0));
        return bytes;
    };
    try {
        const res = await fetch("/api/tiles/cmod278rq000a5zqqg0tssfsd/all", { credentials: "same-origin", cache: "no-store" });
        out.fetch = res.status;
        const json = await res.json();
        out.keyLen = typeof json.key === "string" ? json.key.length : null;
        out.tileCount = Array.isArray(json.tiles) ? json.tiles.length : null;
        const tile = json.tiles[0];
        out.tileKeys = Object.keys(tile);
        out.ivLen = typeof tile.iv === "string" ? tile.iv.length : null;
        out.dataLen = typeof tile.data === "string" ? tile.data.length : null;
        const key = await crypto.subtle.importKey("raw", b64(json.key), { name: "AES-GCM" }, false, ["decrypt"]);
        out.importKey = "ok";
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(tile.iv), tagLength: 128 }, key, b64(tile.data));
        out.decrypt = "ok";
        out.plainLen = plain.byteLength;
        const head = new Uint8Array(plain).slice(0, 16);
        out.plainHead = Array.from(head).map(b => b.toString(16).padStart(2, "0")).join("");
    } catch (error) {
        out.failed = String(error);
    }
    return out;
`;

const log = payload => console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 19), ...payload }));

try {
    await session.connect({
        allowedHosts: ["valirscans.org"],
        controlledCode: `return Boolean(document.querySelector(".hs-home") || document.querySelector(".hs-reader-body"));`,
    });
    await session.navigate("https://valirscans.org/series/comic/my-tyrant-brother-is-a-bonus/chapter/16", {
        matches: (candidate, expected) => navigationMatches(candidate.href, expected),
    });
    await sleep(3000);
    const fg = await controller.foregroundClient();

    // App injection establishes the session cookie.
    const inject = "const source = " + JSON.stringify(bundle) + "; new Function(source + String.fromCharCode(10) + '//# sourceURL=step-debug.js')(); return 'posted';";
    await controller.command(fg.client, inject, { expectResult: false });
    await sleep(9000);
    log({ step: "steps", result: await controller.command(fg.client, STEPS) });
} finally {
    await session.cleanup().catch(error => log({ step: "cleanup-warning", error: String(error) }));
    session.close();
}
