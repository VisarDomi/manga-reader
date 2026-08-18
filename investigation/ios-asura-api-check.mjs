#!/usr/bin/env node
// Verify asura API facts from the live page (script off): slug forms accepted
// by the API, the hex pattern, and whether a stable series id exists.
import { createController } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const controller = createController({
    root,
    name: "manga-reader-asura-api-check",
    connectionTimeoutMs: 10_000,
    commandTimeoutMs: 30_000,
    clientTimeoutMs: 10_000,
    settleMs: 500,
});

const log = payload => console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 19), ...payload }));

await controller.ensureServer();
await controller.waitForDebugger();
const fg = await controller.foregroundClient();
log({ step: "connected", href: fg.href });

const CHECK = String.raw`
    const results = {};
    // 1. Slug forms: with-hex vs without-hex against the series endpoint.
    const withHex = "absolute-regression-b60d532c";
    const withoutHex = "absolute-regression";
    for (const [label, slug] of [["with-hex", withHex], ["without-hex", withoutHex]]) {
        try {
            const res = await fetch("https://api.asurascans.com/api/series/" + slug, { credentials: "include" });
            const text = (await res.text()).slice(0, 120);
            results[label] = { status: res.status, body: text };
        } catch (error) {
            results[label] = { error: String(error) };
        }
    }
    // 2. Hex pattern sample: first 12 slugs from the home list.
    try {
        const home = await fetch("https://api.asurascans.com/api/series?sort=latest&order=desc&limit=12", { credentials: "include" });
        const json = await home.json();
        const series = (json.data ?? []).map(item => ({
            slug: item.slug,
            id: item.id,
            hexTail: String(item.slug ?? "").match(/-[0-9a-f]+$/i)?.[0] ?? null,
        }));
        results.sample = series;
    } catch (error) {
        results.sample = { error: String(error) };
    }
    return results;
`;
log({ step: "check", result: await controller.command(fg.client, CHECK) });
controller.close();
