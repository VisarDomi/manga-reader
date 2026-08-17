#!/usr/bin/env node
// Try HMAC-derived key variants for the tile decrypt.
import { createController, createSession, sleep } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const controller = createController({
    root,
    name: "manga-reader-valir-key-debug",
    connectionTimeoutMs: 60_000,
    commandTimeoutMs: 40_000,
    clientTimeoutMs: 30_000,
    settleMs: 2_000,
});
const session = createSession({ controller, sourceLabel: "manga-reader-valir-key-debug.user.js" });

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
    const tile = json.tiles[0];
    const keyBytes = b64(json.key);
    const derive = async msg => {
        const hmacKey = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const sig = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(msg));
        return crypto.subtle.importKey("raw", sig, { name: "AES-GCM" }, false, ["decrypt"]);
    };
    const tryKey = async (label, key) => {
        try {
            const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(tile.iv), tagLength: 128 }, key, b64(tile.data));
            const head = new Uint8Array(plain).slice(0, 12);
            return label + ": OK " + plain.byteLength + " head=" + Array.from(head).map(b => b.toString(16).padStart(2, "0")).join("");
        } catch (error) {
            return label + ": FAIL";
        }
    };
    const results = [];
    results.push(await tryKey("hmac-pageId", await derive("cmod278rq000a5zqqg0tssfsd")));
    results.push(await tryKey("hmac-tileIndex0", await derive("0")));
    results.push(await tryKey("hmac-iv", await derive(tile.iv)));
    results.push(await tryKey("hmac-empty", await derive("")));
    results.push(await tryKey("hmac-tiles", await derive("tiles")));
    results.push(await tryKey("hmac-data", await derive(tile.data)));
    return { keyLen: keyBytes.length, results };
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
    log({ step: "key-probe", result: await controller.command(fg.client, PROBE) });
} finally {
    await session.cleanup().catch(error => log({ step: "cleanup-warning", error: String(error) }));
    session.close();
}
