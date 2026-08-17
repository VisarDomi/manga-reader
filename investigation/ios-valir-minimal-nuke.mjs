#!/usr/bin/env node
// Minimal valir test: ONLY stop/open/close + a marker. Watch for leaks:
// does the site re-render over the nuked document?
import { createController, createSession, sleep } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const controller = createController({
    root,
    name: "manga-reader-valir-minimal",
    connectionTimeoutMs: 60_000,
    commandTimeoutMs: 20_000,
    clientTimeoutMs: 30_000,
    settleMs: 2_000,
});
const session = createSession({ controller, sourceLabel: "manga-reader-valir-minimal.user.js" });

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
        controlledCode: "return Boolean(document.querySelector('.hs-home') || document.querySelector('.hs-reader-body'));",
    });
    await session.navigate("https://valirscans.org/series/comic/my-tyrant-brother-is-a-bonus/chapter/16#2", {
        matches: (candidate, expected) => navigationMatches(candidate.href, expected),
    });
    await sleep(3000);
    const fg = await controller.foregroundClient();
    log({ step: "foreground", client: fg.client.slice(0, 16) });

    const nuke = "window.stop(); document.open(); document.close(); document.title = 'NUKED'; document.body.innerHTML = '<div id=\"takeover-marker\">NUKED-MARKER</div>'; return true;";
    await controller.command(fg.client, nuke, { expectResult: false });
    log({ step: "nuke-posted" });

    await sleep(2000);
    for (const probe of [1, 2, 3, 4, 5]) {
        const check = "return { marker: !!document.getElementById('takeover-marker'), title: document.title, bodyLen: document.body ? document.body.innerHTML.length : -1, href: location.href };";
        log({ step: "check-" + probe, result: await controller.command(fg.client, check) });
        await sleep(4000);
    }
} finally {
    await session.cleanup().catch(error => log({ step: "cleanup-warning", error: String(error) }));
    session.close();
}
