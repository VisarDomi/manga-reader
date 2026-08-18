#!/usr/bin/env node
// Get absolute-regression's canonical API slug + id, and test the chapter
// endpoint with the hex-suffixed slug.
import { createController } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const controller = createController({
    root,
    name: "manga-reader-asura-api-check2",
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
    const search = await fetch("https://api.asurascans.com/api/series?search=absolute-regression", { credentials: "include" });
    results.searchStatus = search.status;
    const searchJson = await search.json().catch(() => null);
    results.found = (searchJson?.data ?? []).map(item => ({ slug: item.slug, id: item.id })).slice(0, 5);
    // Chapters endpoint with the hex slug vs the canonical slug.
    const canonical = results.found[0]?.slug;
    if (canonical) {
        for (const [label, slug] of [["canonical", canonical], ["hex", canonical + "-b60d532c"]]) {
            const res = await fetch("https://api.asurascans.com/api/series/" + slug + "/chapters", { credentials: "include" });
            results["chapters-" + label] = { status: res.status, head: (await res.text()).slice(0, 80) };
        }
    }
    return results;
`;
log({ step: "check", result: await controller.command(fg.client, CHECK) });
controller.close();
