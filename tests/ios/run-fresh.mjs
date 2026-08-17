#!/usr/bin/env node
// Fresh-run suite: every provider case runs as its own clean
// `node tests/ios/run.mjs <url>` process — no shared harness state, a
// failure in one provider cannot poison the next.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");
const runScript = resolve(root, "tests/ios/run.mjs");

const matrixText = await readFile(resolve(root, "test.txt"), "utf8");
const sections = matrixText.split(String.fromCharCode(10));
const isUrl = line => line.startsWith("http://") || line.startsWith("https://");
const readerStart = sections.findIndex(line => line.startsWith("Test URLs for testing reader"));
const homeStart = sections.findIndex(line => line.startsWith("Test URLs for testing home"));
if (readerStart === -1 || homeStart === -1) {
    throw new Error("test.txt is missing its URL sections");
}
const urls = sections
    .slice(readerStart + 1, homeStart)
    .map(line => line.trim())
    .filter(isUrl);

console.log("Fresh suite: " + urls.length + " provider cases, one clean process each.");

const failures = [];
for (let index = 0; index < urls.length; index++) {
    const url = urls[index];
    const label = "[" + (index + 1) + "/" + urls.length + "] " + new URL(url).hostname.replace(/^www\./, "");
    console.log(label + " ...");
    const exitCode = await new Promise(resolveCode => {
        const child = spawn(process.execPath, [runScript, url], {
            cwd: root,
            stdio: "inherit",
        });
        child.on("exit", code => resolveCode(code ?? 1));
        child.on("error", error => {
            console.error(label + " failed to start: " + error.message);
            resolveCode(1);
        });
    });
    if (exitCode !== 0) {
        failures.push({ url, exitCode });
        console.error(label + " FAILED (exit " + exitCode + ")");
    } else {
        console.log(label + " OK");
    }
}

if (failures.length) {
    console.error(failures.length + "/" + urls.length + " providers failed:");
    for (const failure of failures) console.error("  " + failure.url);
    process.exitCode = 1;
} else {
    console.log("All " + urls.length + " provider cases passed (fresh runs).");
}
