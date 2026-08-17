#!/usr/bin/env node
// Does the phone's debugger receive and execute a ~136KB command?
import { createController, createSession } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const controller = createController({
    root,
    name: "manga-reader-big-command-probe",
    connectionTimeoutMs: 60_000,
    commandTimeoutMs: 25_000,
    clientTimeoutMs: 30_000,
});
const session = createSession({ controller, sourceLabel: "manga-reader-big-command-probe.user.js" });

const log = payload => console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 19), ...payload }));

try {
    await session.connect({
        allowedHosts: ["example.com"],
        controlledCode: "return false;",
    });
    log({ step: "connected" });

    log({ step: "small-command", result: await session.command("return 1 + 1;") });

    const padding = " ".repeat(136_000);
    const big = "const pad = " + JSON.stringify(padding) + "; return { ok: true, len: pad.length };";
    log({ step: "big-command-start", bytes: big.length });
    try {
        const result = await session.command(big);
        log({ step: "big-command-done", result });
    } catch (error) {
        log({ step: "big-command-failed", error: String(error) });
    }

    log({ step: "small-command-after", result: await session.command("return 'still-alive';") });
} finally {
    await session.cleanup().catch(error => log({ step: "cleanup-warning", error: String(error) }));
    session.close();
}
