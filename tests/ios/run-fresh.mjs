#!/usr/bin/env node
// Fresh-run suite: every case runs as its own clean
// `node tests/ios/run.mjs` process — no shared harness state, a failure in
// one provider cannot poison the next. Reader cases and home cases each run
// fresh.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");
const runScript = resolve(root, "tests/ios/run.mjs");

const matrixText = await readFile(resolve(root, "test.txt"), "utf8");
const sections = matrixText.split(String.fromCharCode(10));
const isUrl = line => line.startsWith("http://") || line.startsWith("https://");

function sectionUrls(header) {
    const start = sections.findIndex(line => line.startsWith(header));
    if (start === -1) return [];
    const end = sections.findIndex((line, index) => index > start && line.startsWith("Test URLs for"));
    const tail = end === -1 ? sections.slice(start + 1) : sections.slice(start + 1, end);
    return tail.map(line => line.trim()).filter(isUrl);
}

const readerUrls = sectionUrls("Test URLs for testing reader");
const homeUrls = sectionUrls("Test URLs for testing home");
const cases = [
    ...readerUrls.map(url => ({ url, args: [url], kind: "reader" })),
    ...homeUrls.map(url => ({ url, args: ["--test", "home", url], kind: "home" })),
];

console.log("Fresh suite: " + readerUrls.length + " reader + " + homeUrls.length + " home cases, one clean process each.");

const failures = [];
for (let index = 0; index < cases.length; index++) {
    const testCase = cases[index];
    const label = "[" + (index + 1) + "/" + cases.length + "] " + testCase.kind + " " + new URL(testCase.url).hostname.replace(/^www\./, "");
    console.log(label + " ...");
    const exitCode = await new Promise(resolveCode => {
        const child = spawn(process.execPath, [runScript, ...testCase.args], {
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
        failures.push({ ...testCase, exitCode });
        console.error(label + " FAILED (exit " + exitCode + ")");
    } else {
        console.log(label + " OK");
    }
}

if (failures.length) {
    console.error(failures.length + "/" + cases.length + " cases failed:");
    for (const failure of failures) console.error("  " + failure.kind + " " + failure.url);
    process.exitCode = 1;
} else {
    console.log("All " + cases.length + " cases passed (fresh runs).");
}
