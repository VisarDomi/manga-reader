#!/usr/bin/env node
// Stage 1: connect + navigate to asura + readiness snapshot. No injection.
import { createController, createSession } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const controller = createController({
    root,
    name: "manga-reader-stage1",
    connectionTimeoutMs: 60_000,
    commandTimeoutMs: 20_000,
    clientTimeoutMs: 30_000,
    settleMs: 2_000,
});
const session = createSession({
    controller,
    sourceLabel: "manga-reader-stage1.user.js",
});

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
    log({ step: "connect-start" });
    await session.connect({
        allowedHosts: ["asurascans.com"],
        controlledCode: "return Boolean(document.querySelector('.hs-home') || document.querySelector('.hs-reader-body'));",
    });
    log({ step: "connect-done" });

    log({ step: "navigate-start" });
    await session.navigate("https://asurascans.com/", {
        matches: (candidate, expected) => navigationMatches(candidate.href, expected),
    });
    log({ step: "navigate-done" });

    // The page reloads itself shortly after load; re-claim the LIVE
    // foreground client instead of the one navigate adopted.
    const fg = await controller.foregroundClient();
    log({ step: "foreground", client: fg.client.slice(0, 16), href: fg.href });

    log({ step: "readiness", result: await controller.command(fg.client, "return { href: location.href, title: document.title };") });
} finally {
    await session.cleanup().catch(error => log({ step: "cleanup-warning", error: String(error) }));
    session.close();
}
