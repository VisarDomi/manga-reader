#!/usr/bin/env node
// Try decrypt variants: API iv vs page-record iv.
import { createController, createSession, sleep } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const controller = createController({
    root,
    name: "manga-reader-valir-iv-debug",
    connectionTimeoutMs: 60_000,
    commandTimeoutMs: 40_000,
    clientTimeoutMs: 30_000,
    settleMs: 2_000,
});
const session = createSession({ controller, sourceLabel: "manga-reader-valir-iv-debug.user.js" });

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

const PROBE = String.raw`
    const b64 = v => Uint8Array.from(atob(v), c => c.charCodeAt(0));
    const res = await fetch("/api/tiles/cmod278rq000a5zqqg0tssfsd/all", { credentials: "same-origin", cache: "no-store" });
    const json = await res.json();
    const key = await crypto.subtle.importKey("raw", b64(json.key), { name: "AES-GCM" }, false, ["decrypt"]);
    const tile = json.tiles[0];
    const tryIv = async (label, iv) => {
        try {
            const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(iv), tagLength: 128 }, key, b64(tile.data));
            const head = new Uint8Array(plain).slice(0, 12);
            return label + ": OK, " + plain.byteLength + " bytes, head=" + Array.from(head).map(b => b.toString(16).padStart(2, "0")).join("");
        } catch (error) {
            return label + ": FAIL " + String(error);
        }
    };
    return {
        apiIv: tile.iv,
        apiIvTry: await tryIv("api-iv", tile.iv),
        recordIvTry: await tryIv("record-iv", "Ilvlh1qn03WtDh3M"),
    };
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
    log({ step: "iv-probe", result: await controller.command(fg.client, PROBE) });
} finally {
    await session.cleanup().catch(error => log({ step: "cleanup-warning", error: String(error) }));
    session.close();
}
