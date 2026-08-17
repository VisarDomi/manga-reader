#!/usr/bin/env node
// Minimal takeover test: the 3 lines, nothing else. Observe whether the new
// document survives or the site's live JS re-renders over it.
import { createController, createSession, sleep } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const controller = createController({
    root,
    name: "manga-reader-takeover-minimal",
    connectionTimeoutMs: 60_000,
    commandTimeoutMs: 20_000,
    clientTimeoutMs: 30_000,
    settleMs: 2_000,
});
const session = createSession({ controller, sourceLabel: "manga-reader-takeover-minimal.user.js" });

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
    log({ step: "connected" });

    await session.navigate("https://asurascans.com/", {
        matches: (candidate, expected) => navigationMatches(candidate.href, expected),
    });
    await sleep(3000);
    const fg = await controller.foregroundClient();
    log({ step: "foreground", client: fg.client.slice(0, 16) });

    // The 3 lines + a marker, fire-and-forget.
    const nuke = "window.stop(); document.open(); document.close(); document.body.innerHTML = '<div id=\"takeover-marker\">TAKEOVER</div>'; return true;";
    await controller.command(fg.client, nuke, { expectResult: false });
    log({ step: "nuke-posted" });

    // Let the nuke settle, then one plain marker check — no in-page loop that
    // could race document.open().
    await sleep(3000);
    for (const probe of [1, 2, 3]) {
        const check = "return { marker: !!document.getElementById('takeover-marker'), title: document.title, bodyLen: document.body ? document.body.innerHTML.length : -1 };";
        const result = await controller.command(fg.client, check);
        log({ step: "marker-check-" + probe, result });
        await sleep(2000);
    }
} finally {
    await session.cleanup().catch(error => log({ step: "cleanup-warning", error: String(error) }));
    session.close();
}
