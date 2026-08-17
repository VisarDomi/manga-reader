#!/usr/bin/env node
// Debug: extract pageIds from the runtime chapter HTML and probe the endpoint.
import { createController, createSession, sleep } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const controller = createController({
    root,
    name: "manga-reader-valir-id-debug",
    connectionTimeoutMs: 60_000,
    commandTimeoutMs: 40_000,
    clientTimeoutMs: 30_000,
    settleMs: 2_000,
});
const session = createSession({ controller, sourceLabel: "manga-reader-valir-id-debug.user.js" });

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

const DEBUG = String.raw`
    const res = await fetch(location.href, { credentials: "same-origin" });
    const html = await res.text();
    const pageDataRe = /\\"id\\":\\"([^"\\]+)\\"[^}]*?\\"pageNumber\\":(\d+)[^}]*?\\"imageUrl\\":\\"([^"\\]+)\\"[^}]*?\\"width\\":(\d+)[^}]*?\\"height\\":(\d+)[^}]*?\\"isEncrypted\\":(true|false)/g;
    const ids = [...html.matchAll(pageDataRe)].slice(0, 3).map(m => ({
        id: m[1],
        pageNumber: m[2],
        encrypted: m[6],
        imageUrlTail: m[3].split("/").pop()?.slice(0, 30),
    }));
    const probes = [];
    for (const entry of ids) {
        const t = await fetch("/api/tiles/" + entry.id + "/all", { credentials: "same-origin", cache: "no-store" });
        probes.push({ id: entry.id, status: t.status });
    }
    return { ids, probes, cookieNames: document.cookie.split(";").map(s => s.trim().split("=")[0]).filter(Boolean) };
`;

const log = payload => console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 19), ...payload }));

try {
    await session.connect({
        allowedHosts: ["valirscans.org"],
        controlledCode: `return Boolean(document.querySelector(".hs-home") || document.querySelector(".hs-reader-body"));`,
    });
    await session.navigate("https://valirscans.org/series/comic/my-tyrant-brother-is-a-bonus/chapter/16#2", {
        matches: (candidate, expected) => navigationMatches(candidate.href, expected),
    });
    await sleep(3000);
    const fg = await controller.foregroundClient();
    log({ step: "debug", result: await controller.command(fg.client, DEBUG) });
} finally {
    await session.cleanup().catch(error => log({ step: "cleanup-warning", error: String(error) }));
    session.close();
}
