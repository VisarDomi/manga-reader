#!/usr/bin/env node
// Inject the full bundle, then read markers showing how far main() got.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createController, createSession, sleep } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const bundle = await readFile(resolve(root, "dist/manga-reader.user.js"), "utf8");

const controller = createController({
    root,
    name: "manga-reader-bundle-trace",
    connectionTimeoutMs: 60_000,
    commandTimeoutMs: 20_000,
    clientTimeoutMs: 30_000,
    settleMs: 2_000,
});
const session = createSession({ controller, sourceLabel: "manga-reader-bundle-trace.user.js" });

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
        allowedHosts: ["asurascans.com"],
        controlledCode: "return Boolean(document.querySelector('.hs-home') || document.querySelector('.hs-reader-body'));",
    });
    await session.navigate("https://asurascans.com/", {
        matches: (candidate, expected) => navigationMatches(candidate.href, expected),
    });
    await sleep(3000);
    const fg = await controller.foregroundClient();
    log({ step: "foreground", client: fg.client.slice(0, 16) });

    // Kill site reload timers (NOT before: the sweep could eat the debugger's
    // poll timer — instead block reloads by replacing the reload primitives).
    await controller.command(fg.client, "return true;");

    const inject = "const source = " + JSON.stringify(bundle) + "; new Function(source + String.fromCharCode(10) + '//# sourceURL=trace.js')(); return 'posted';";
    await controller.command(fg.client, inject, { expectResult: false });
    log({ step: "inject-posted" });

    await sleep(4000);
    const trace = "return {"
        + "title: document.title,"
        + "hasStyle: !!document.querySelector('style'),"
        + "hasLoading: !!document.querySelector('.hs-home-loading'),"
        + "hasCards: !!document.querySelector('.hs-home-card'),"
        + "hasHome: !!document.querySelector('.hs-home'),"
        + "hasError: document.querySelector('.hs-home-error') ? document.querySelector('.hs-home-error').textContent : null,"
        + "bodyLen: document.body ? document.body.innerHTML.length : -1"
        + "};";
    log({ step: "trace-1", result: await controller.command(fg.client, trace) });
    await sleep(5000);
    log({ step: "trace-2", result: await controller.command(fg.client, trace) });
} finally {
    await session.cleanup().catch(error => log({ step: "cleanup-warning", error: String(error) }));
    session.close();
}
