#!/usr/bin/env node
// Install an error-event capture on the LIVE page. The listener survives a
// bfcache revive, so the next swipe-back reproduces the failure into the stash.
import { createController } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const controller = createController({
    root,
    name: "manga-reader-error-capture",
    connectionTimeoutMs: 10_000,
    commandTimeoutMs: 15_000,
    clientTimeoutMs: 10_000,
    settleMs: 500,
});

const log = payload => console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 19), ...payload }));

await controller.ensureServer();
await controller.waitForDebugger();
const fg = await controller.foregroundClient();
log({ step: "connected", href: fg.href });

const CAPTURE = String.raw`
    const stash = [];
    const record = entry => {
        stash.push(entry);
        try {
            const existing = JSON.parse(sessionStorage.getItem("__mrr_errcap") ?? "[]");
            existing.push(entry);
            sessionStorage.setItem("__mrr_errcap", JSON.stringify(existing.slice(-20)));
        } catch { /* storage may be unavailable */ }
    };
    window.__mrr_errstash = stash;
    window.addEventListener("error", e => {
        record({
            kind: "error",
            message: e.message,
            filename: e.filename ?? null,
            target: e.target && e.target !== window ? e.target.tagName ?? String(e.target) : "window",
            errorName: e.error ? e.error.name : null,
            stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 500) : null,
        });
    });
    window.addEventListener("unhandledrejection", e => {
        record({ kind: "rejection", reason: String(e.reason), stack: e.reason && e.reason.stack ? String(e.reason.stack).slice(0, 500) : null });
    });
    return { installed: true, href: location.href };
`;
log({ step: "capture", result: await controller.command(fg.client, CAPTURE) });
log({ step: "ready" });
controller.close();
