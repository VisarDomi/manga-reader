#!/usr/bin/env node
// Capture a module-init/boot crash: error trap + banner, then read both.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createController } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const bundle = await readFile(resolve(root, "dist/manga-reader.user.js"), "utf8");
const controller = createController({
    root,
    name: "manga-reader-boot-error",
    connectionTimeoutMs: 10_000,
    commandTimeoutMs: 20_000,
    clientTimeoutMs: 10_000,
    settleMs: 500,
});

const log = payload => console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 19), ...payload }));

await controller.ensureServer();
await controller.waitForDebugger();
const fg = await controller.foregroundClient();
log({ step: "connected", href: fg.href });

const INJECT = [
    "globalThis.__errs = [];",
    "window.addEventListener('error', e => globalThis.__errs.push('error: ' + (e.message || 'unknown') + ' @' + (e.filename ?? '')));",
    "window.addEventListener('unhandledrejection', e => globalThis.__errs.push('rejection: ' + String(e.reason && e.reason.stack ? e.reason.stack.slice(0, 300) : e.reason)));",
    "try {",
    "    const source = " + JSON.stringify(bundle) + ";",
    "    new Function(source + String.fromCharCode(10) + '//# sourceURL=boot-check.user.js')();",
    "    globalThis.__errs.push('bundle evaluated without sync throw');",
    "} catch (error) {",
    "    globalThis.__errs.push('sync throw: ' + (error && error.stack ? error.stack.slice(0, 400) : String(error)));",
    "}",
    "return true;",
].join("\n");

await controller.command(fg.client, INJECT, { expectResult: false });
await new Promise(res => setTimeout(res, 6000));
const fg2 = await controller.foregroundClient();
const READ = String.raw`
    return {
        errs: globalThis.__errs ?? null,
        fatal: document.getElementById("hs-fatal-error")?.textContent ?? null,
        hasHome: !!document.querySelector(".hs-home"),
        title: document.title,
        bodyLen: document.body ? document.body.innerHTML.length : -1,
    };
`;
log({ step: "state", result: await controller.command(fg2.client, READ) });
controller.close();
