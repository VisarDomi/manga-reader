#!/usr/bin/env node
// Read the authenticated /api/tiles response shape from the phone's page.
import { createController, createSession, sleep } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const controller = createController({
    root,
    name: "manga-reader-valir-tiles-shape",
    connectionTimeoutMs: 60_000,
    commandTimeoutMs: 30_000,
    clientTimeoutMs: 30_000,
    settleMs: 2_000,
});
const session = createSession({ controller, sourceLabel: "manga-reader-valir-tiles-shape.user.js" });

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

    const shape = await controller.command(fg.client, String.raw`
        const res = await fetch("/api/tiles/cmod278rq00095zqqzo0prcgf/all", { credentials: "same-origin", cache: "no-store" });
        if (!res.ok) return { status: res.status, body: (await res.text()).slice(0, 200) };
        const json = await res.json();
        const entries = Array.isArray(json.tiles)
            ? json.tiles.slice(0, 2)
            : Object.entries(json.tiles ?? {}).slice(0, 2);
        return {
            status: res.status,
            topKeys: Object.keys(json).slice(0, 8),
            keyType: typeof json.key,
            keyLength: typeof json.key === "string" ? json.key.length : null,
            keyPrefix: typeof json.key === "string" ? json.key.slice(0, 12) : null,
            tileSample: entries.map(([k, v]) => ({
                k,
                type: Array.isArray(v) ? "array" : typeof v,
                keys: v && typeof v === "object" ? Object.keys(v).slice(0, 8) : null,
                size: v && typeof v === "string" ? v.length : JSON.stringify(v ?? null).length,
                head: v && typeof v === "string" ? v.slice(0, 24) : null,
            })),
        };
    `);
    log({ step: "tiles-shape", shape });
} finally {
    await session.cleanup().catch(error => log({ step: "cleanup-warning", error: String(error) }));
    session.close();
}
