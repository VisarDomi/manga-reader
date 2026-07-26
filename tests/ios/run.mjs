#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import https from "node:https";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const bridgeOrigin = process.env.IOS_DEBUG_ORIGIN ?? "https://127.0.0.1:19999";
const casePauseMs = Math.max(1000, Number(process.env.IOS_TEST_SETTLE_MS ?? 1000));
const commandTimeoutMs = Number(process.env.IOS_TEST_COMMAND_TIMEOUT_MS ?? 90000);
const clientTimeoutMs = Number(process.env.IOS_TEST_CLIENT_TIMEOUT_MS ?? 45000);
const agent = new https.Agent({ rejectUnauthorized: false });
let ownedServer = null;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function request(path, { method = "GET", body } = {}) {
    return new Promise((resolveRequest, rejectRequest) => {
        const url = new URL(path, bridgeOrigin);
        const payload = body === undefined ? null : JSON.stringify(body);
        const req = https.request(url, {
            method,
            agent,
            headers: payload ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
            } : undefined,
        }, response => {
            const chunks = [];
            response.on("data", chunk => chunks.push(chunk));
            response.on("end", () => {
                const text = Buffer.concat(chunks).toString();
                if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
                    rejectRequest(new Error(`${method} ${url.pathname}: HTTP ${response.statusCode}: ${text}`));
                    return;
                }
                if (!text) {
                    resolveRequest(null);
                    return;
                }
                try {
                    resolveRequest(JSON.parse(text));
                } catch {
                    rejectRequest(new Error(`${method} ${url.pathname}: invalid JSON response`));
                }
            });
        });
        req.on("error", rejectRequest);
        if (payload) req.write(payload);
        req.end();
    });
}

async function ensureServer() {
    try {
        await request("/__debug_state");
        return;
    } catch {
        ownedServer = spawn("python3", [resolve(here, "bridge_server.py")], {
            cwd: root,
            stdio: ["ignore", "ignore", "inherit"],
        });
    }

    for (let attempt = 0; attempt < 30; attempt++) {
        if (ownedServer.exitCode !== null) {
            throw new Error("The repository-local iOS bridge failed to start. Run `npm run tests:setup`.");
        }
        try {
            await request("/__debug_state");
            return;
        } catch {
            await sleep(250);
        }
    }
    throw new Error("Timed out starting the repository-local iOS bridge.");
}

async function state() {
    return request("/__debug_state");
}

async function postCommand(target, code) {
    const command = await request("/__debug_command", {
        method: "POST",
        body: { target, code },
    });
    return command.id;
}

async function waitForResult(commandId) {
    const deadline = Date.now() + commandTimeoutMs;
    while (Date.now() < deadline) {
        const snapshot = await state();
        const result = [...snapshot.results].reverse().find(item => item.commandId === commandId);
        if (result) {
            if (!result.ok) {
                const error = result.error?.message ?? JSON.stringify(result.error);
                throw new Error(`Remote command ${commandId} failed: ${error}`);
            }
            return result.result;
        }
        await sleep(250);
    }
    throw new Error(`Timed out waiting for remote command ${commandId}`);
}

async function command(target, code, { expectResult = true } = {}) {
    const id = await postCommand(target, code);
    return expectResult ? waitForResult(id) : id;
}

function newestClient(snapshot) {
    return [...snapshot.clients].sort((a, b) => b.lastSeen - a.lastSeen)[0];
}

async function waitForNewClient(knownClients, urlBase) {
    const deadline = Date.now() + clientTimeoutMs;
    while (Date.now() < deadline) {
        const snapshot = await state();
        const client = [...snapshot.clients]
            .filter(item => !knownClients.has(item.client) && item.href.startsWith(urlBase))
            .sort((a, b) => b.lastSeen - a.lastSeen)[0];
        if (client) return client;
        await sleep(250);
    }
    throw new Error(`No iPhone debugger connected at ${urlBase}`);
}

function describeCase(urlText) {
    const url = new URL(urlText);
    const hostname = url.hostname.replace(/^www\./, "");
    const name = hostname.split(".")[0];
    if (hostname === "cubari.moe") {
        const parts = url.pathname.split("/").filter(Boolean);
        const page = Number(parts.at(-1));
        return {
            name,
            url: urlText,
            urlBase: `${url.origin}/${parts.slice(0, -1).join("/")}/`,
            imageIndex: String(page - 1),
        };
    }
    return {
        name,
        url: urlText,
        urlBase: `${url.origin}${url.pathname}`,
        imageIndex: url.hash.slice(1),
    };
}

function injectCode(bundle, url) {
    return `
        history.replaceState(null, "", ${JSON.stringify(url)});
        const source = ${JSON.stringify(bundle)};
        new Function(source + String.fromCharCode(10) + "//# sourceURL=manga-reader.test.user.js")();
        return { injectedBytes: source.length };
    `;
}

function initialAssertions(testCase) {
    return `
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const expected = ${JSON.stringify(testCase.imageIndex)};

        for (let i = 0; i < 240 && !document.querySelector(".hs-reader-body"); i++) await wait(250);
        for (let i = 0; i < 240; i++) {
            const target = document.getElementById("#" + expected);
            const rect = target?.getBoundingClientRect();
            if (target?.complete && target.naturalHeight && rect && rect.bottom > 0 && rect.top < innerHeight) break;
            await wait(250);
        }

        let chapters = Array.from(document.querySelectorAll(".hs-chapter"));
        if (chapters.length === 1) {
            dispatchEvent(new Event("scrollend"));
            for (let i = 0; i < 160 && document.querySelectorAll(".hs-chapter").length === 1; i++) await wait(250);
        }
        await wait(1000);

        chapters = Array.from(document.querySelectorAll(".hs-chapter"));
        const target = document.getElementById("#" + expected);
        const rect = target?.getBoundingClientRect();
        return {
            readerLoaded: !!document.querySelector(".hs-reader-body"),
            chapterIds: chapters.map(element => element.dataset.chapter),
            exactlyOneNewer: chapters.length === 2,
            expectedImageFound: !!target,
            expectedImageVisible: !!rect && rect.bottom > 0 && rect.top < innerHeight,
            statuses: Array.from(document.querySelectorAll(".hs-status")).map(element => element.textContent),
            href: location.href,
        };
    `;
}

function refreshAssertions(testCase) {
    return `
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const expected = ${JSON.stringify(testCase.imageIndex)};
        for (let i = 0; i < 240; i++) {
            const target = document.getElementById("#" + expected);
            const rect = target?.getBoundingClientRect();
            if (target?.complete && target.naturalHeight && rect && rect.bottom > 0 && rect.top < innerHeight) break;
            await wait(250);
        }
        const target = document.getElementById("#" + expected);
        const rect = target?.getBoundingClientRect();
        return {
            readerLoaded: !!document.querySelector(".hs-reader-body"),
            expectedImageFound: !!target,
            expectedImageVisible: !!rect && rect.bottom > 0 && rect.top < innerHeight,
            href: location.href,
        };
    `;
}

function assertResult(testCase, phase, result) {
    const failures = [];
    if (!result.readerLoaded) failures.push("reader did not load");
    if (!result.expectedImageFound) failures.push(`image ${testCase.imageIndex} was not rendered`);
    if (!result.expectedImageVisible) failures.push(`image ${testCase.imageIndex} was not visible`);
    if (phase === "initial" && !result.exactlyOneNewer) {
        failures.push(`expected exactly two chapters, got ${result.chapterIds?.length ?? 0}`);
    }
    if (failures.length) throw new Error(failures.join("; "));
}

async function navigateFromActive(testCase) {
    const before = await state();
    const active = newestClient(before);
    if (!active) {
        throw new Error("No iPhone debugger is connected. Open any Safari page with debug.user.js enabled.");
    }
    const known = new Set(before.clients.map(item => item.client));
    await command(active.client, `location.href = ${JSON.stringify(testCase.url)}; return "navigating";`);
    return waitForNewClient(known, testCase.urlBase);
}

async function runCase(testCase, bundle) {
    const navigationClient = await navigateFromActive(testCase);
    await command(navigationClient.client, injectCode(bundle, testCase.url));
    const initial = await command(navigationClient.client, initialAssertions(testCase));
    assertResult(testCase, "initial", initial);

    await sleep(casePauseMs);

    const beforeRefresh = await state();
    const known = new Set(beforeRefresh.clients.map(item => item.client));
    await command(
        navigationClient.client,
        `history.replaceState(null, "", ${JSON.stringify(testCase.url)}); location.reload(); return "reloading";`,
    );
    const refreshClient = await waitForNewClient(known, testCase.urlBase);
    await command(refreshClient.client, injectCode(bundle, testCase.url));
    const refreshed = await command(refreshClient.client, refreshAssertions(testCase));
    assertResult(testCase, "refresh", refreshed);

    return { initial, refreshed };
}

async function main() {
    await ensureServer();
    const [matrixText, bundle] = await Promise.all([
        readFile(resolve(root, "test.txt"), "utf8"),
        readFile(resolve(root, "dist/manga-reader.user.js"), "utf8"),
    ]);
    const cases = matrixText
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => /^https?:\/\//.test(line))
        .map(describeCase);

    if (!cases.length) throw new Error("test.txt contains no test URLs");

    console.log(`iOS Safari matrix: ${cases.length} cases; ${casePauseMs}ms minimum pause between phases/cases`);
    const failures = [];

    for (const [index, testCase] of cases.entries()) {
        if (index > 0) await sleep(casePauseMs);
        process.stdout.write(`[${index + 1}/${cases.length}] ${testCase.name} ... `);
        try {
            const result = await runCase(testCase, bundle);
            console.log(`PASS (${result.initial.chapterIds.join(" → ")}, image ${testCase.imageIndex} restored)`);
        } catch (error) {
            failures.push({ name: testCase.name, error });
            console.log(`FAIL\n    ${error.message}`);
        }
    }

    if (failures.length) {
        console.error(`\n${failures.length}/${cases.length} iOS Safari cases failed.`);
        process.exitCode = 1;
    } else {
        console.log(`\nAll ${cases.length} iOS Safari cases passed.`);
    }
}

try {
    await main();
} finally {
    if (ownedServer && ownedServer.exitCode === null) ownedServer.kill();
}
