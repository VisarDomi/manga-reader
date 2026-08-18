#!/usr/bin/env node
// Foreground connect, fail-fast, with visible progress.
import { createController } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const controller = createController({
    root,
    name: "manga-reader-live-inspect",
    connectionTimeoutMs: 10_000,
    commandTimeoutMs: 15_000,
    clientTimeoutMs: 10_000,
    settleMs: 500,
});

const log = payload => console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 19), ...payload }));

log({ step: "ensure-server" });
await controller.ensureServer();
log({ step: "wait-debugger" });
await controller.waitForDebugger();
log({ step: "foreground" });
const fg = await controller.foregroundClient();
log({ step: "connected", client: fg.client.slice(0, 16), href: fg.href });

const INSPECT = String.raw`
    return {
        href: location.href,
        hasHome: !!document.querySelector(".hs-home"),
        hasReader: !!document.querySelector(".hs-reader-body"),
        fatal: document.getElementById("hs-fatal-error")?.textContent ?? null,
        cards: document.querySelectorAll(".hs-home-card").length,
        status: document.querySelector(".hs-home-catalog-status")?.textContent ?? null,
    };
`;
log({ step: "state", result: await controller.command(fg.client, INSPECT) });
controller.close();
