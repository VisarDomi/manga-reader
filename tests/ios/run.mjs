#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import https from "node:https";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const bridgeOrigin = process.env.IOS_DEBUG_ORIGIN ?? "https://127.0.0.1:37777";
const casePauseMs = Math.max(1000, Number(process.env.IOS_TEST_SETTLE_MS ?? 1000));
const commandTimeoutMs = Number(process.env.IOS_TEST_COMMAND_TIMEOUT_MS ?? 90000);
const clientTimeoutMs = Number(process.env.IOS_TEST_CLIENT_TIMEOUT_MS ?? 45000);
const connectionTimeoutMs = Number(process.env.IOS_TEST_CONNECTION_TIMEOUT_MS ?? 120000);
const agent = new https.Agent({ rejectUnauthorized: false });
let ownedServer = null;
let claimedClient = null;

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

async function waitForDebugger() {
    const info = await request("/__debug_info");
    console.log(`Waiting for iPhone debugger on port ${new URL(bridgeOrigin).port}.`);
    console.log(`If it is not installed yet, open:\n  ${info.debuggerUrl}`);

    const deadline = Date.now() + connectionTimeoutMs;
    while (Date.now() < deadline) {
        const snapshot = await state();
        const now = Date.now() / 1000;
        const active = snapshot.clients.some(client => now - client.lastSeen < 3);
        if (active) return;
        await sleep(250);
    }

    throw new Error(
        "No iPhone debugger is connected to the repository bridge.\n" +
        `Install or update “manga-reader debug” from:\n  ${info.debuggerUrl}\n` +
        "Then open any matched page in foreground Safari and rerun `npm run tests`.\n" +
        "The older central “debug” userscript on port 35897 does not connect to this suite.",
    );
}

function runLocalCommand(command, args) {
    const completed = spawnSync(command, args, { cwd: root, stdio: "inherit" });
    if (completed.error) throw completed.error;
    if (completed.status !== 0) {
        throw new Error(`${command} ${args.join(" ")} failed with exit code ${completed.status}`);
    }
}

function checkAndBuild() {
    runLocalCommand("npx", ["tsc", "--noEmit"]);
    runLocalCommand("node", ["scripts/build.mjs", "--no-increase-version"]);
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

async function foregroundClient() {
    const snapshot = await state();
    const now = Date.now() / 1000;
    const active = snapshot.clients.filter(client => now - client.lastSeen < 3);
    if (!active.length) throw new Error("No active iPhone debugger client");

    const commandId = await postCommand("*", `
        return {
            visibilityState: document.visibilityState,
            hasFocus: document.hasFocus(),
            href: location.href,
        };
    `);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const current = await state();
        const results = current.results.filter(result =>
            result.commandId === commandId && result.ok
        );
        const focused = results.find(result =>
            result.result?.visibilityState === "visible" && result.result?.hasFocus
        );
        const visible = focused ?? results.find(result =>
            result.result?.visibilityState === "visible"
        );
        if (visible) {
            const client = active.find(item => item.client === visible.client);
            if (client) return client;
        }
        await sleep(100);
    }
    if (active.length === 1) return active[0];
    throw new Error(
        `Could not identify the foreground Safari tab among ${active.length} active debugger clients`,
    );
}

async function claimExampleTab() {
    const client = await foregroundClient();
    const url = new URL(client.href);
    if (url.hostname !== "example.com") {
        throw new Error(
            "The foreground Safari tab must be on https://example.com before running tests.\n" +
            `Foreground tab is currently: ${client.href}`,
        );
    }
    claimedClient = client;
    console.log(`Claimed foreground Safari tab at ${client.href}.`);
}

async function waitForNewClient(knownClients, expectedUrl) {
    const deadline = Date.now() + clientTimeoutMs;
    while (Date.now() < deadline) {
        const snapshot = await state();
        const client = [...snapshot.clients]
            .filter(item => !knownClients.has(item.client) && item.href === expectedUrl)
            .sort((a, b) => b.lastSeen - a.lastSeen)[0];
        if (client) return client;
        await sleep(250);
    }
    throw new Error(`No iPhone debugger connected at ${expectedUrl}`);
}

function describeCase(urlText) {
    const url = new URL(urlText);
    const hostname = url.hostname.replace(/^www\./, "");
    return {
        name: hostname.split(".")[0],
        url: urlText,
    };
}

function injectCode(bundle, url, { cancelRestore = false } = {}) {
    return `
        history.replaceState(null, "", ${JSON.stringify(url)});
        clearInterval(globalThis.__mangaReaderHrefMonitor);
        globalThis.__mangaReaderHrefSamples = [location.href];
        globalThis.__mangaReaderHrefMonitor = setInterval(
            () => globalThis.__mangaReaderHrefSamples.push(location.href),
            25,
        );
        ${cancelRestore ? `
        const cancelRestoreInterval = setInterval(() => {
            dispatchEvent(new Event("touchstart"));
        }, 25);
        setTimeout(() => clearInterval(cancelRestoreInterval), 3000);
        ` : ""}
        const source = ${JSON.stringify(bundle)};
        new Function(source + String.fromCharCode(10) + "//# sourceURL=manga-reader.test.user.js")();
        return { injectedBytes: source.length };
    `;
}

function restoreAssertions(expectedUrl) {
    return `
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const expectedUrl = ${JSON.stringify(expectedUrl)};
        for (let i = 0; i < 60; i++) {
            const body = document.querySelector(".hs-reader-body");
            const target = document.querySelector('[data-restore-target="true"]');
            const rect = target?.getBoundingClientRect();
            if (
                body?.dataset.restoreState === "complete" &&
                target?.complete &&
                target.naturalWidth > 0 &&
                rect &&
                Math.abs(rect.top) <= 1
            ) break;
            await wait(250);
        }
        const body = document.querySelector(".hs-reader-body");
        const targets = Array.from(document.querySelectorAll('[data-restore-target="true"]'));
        const target = targets[0];
        const rect = target?.getBoundingClientRect();
        return {
            readerBodies: document.querySelectorAll(".hs-reader-body").length,
            chapterIds: Array.from(document.querySelectorAll(".hs-chapter")).map(element => element.dataset.chapter),
            targetCount: targets.length,
            targetLoaded: !!target?.complete && target.naturalWidth > 0,
            targetTop: rect?.top ?? null,
            restoreState: body?.dataset.restoreState ?? null,
            href: location.href,
            hrefStable: (globalThis.__mangaReaderHrefSamples || []).every(href => href === expectedUrl),
            targetUrl: target?.dataset.readerUrl ?? null,
        };
    `;
}

function saveAssertions() {
    return `
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const chapter = document.querySelector(".hs-chapter");
        const images = Array.from(chapter?.querySelectorAll(".hs-reader-img") || []);
        const target = images.find(image => image.dataset.restoreTarget !== "true" && image.complete && image.naturalWidth > 0)
            || images.find(image => image.complete && image.naturalWidth > 0);
        if (!target) return { error: "no loaded image available for save test" };

        const originalTransform = target.style.transform;
        const desiredTop = innerHeight / 2 - 10;
        const currentTop = target.getBoundingClientRect().top;
        target.style.transform = "translateY(" + (desiredTop - currentTop) + "px)";
        await wait(50);
        const before = location.href;
        dispatchEvent(new Event("scrollend"));
        await wait(50);
        const beforeDelayElapsed = location.href;
        await wait(100);

        const midpoint = innerHeight / 2;
        const eligible = Array.from(document.querySelectorAll(".hs-reader-img"))
            .filter(image => image.complete && image.naturalWidth > 0)
            .map(image => ({ image, top: image.getBoundingClientRect().top }))
            .filter(item => item.top <= midpoint)
            .sort((a, b) => b.top - a.top);
        const selected = eligible[0]?.image;
        const result = {
            before,
            beforeDelayElapsed,
            href: location.href,
            expectedUrl: selected?.dataset.readerUrl ?? null,
            selectedId: selected?.id ?? null,
            selectedLoaded: !!selected?.complete && selected.naturalWidth > 0,
        };
        target.style.transform = originalTransform;
        return result;
    `;
}

function chapterAssertions() {
    return `
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const chapterIds = () => Array.from(document.querySelectorAll(".hs-chapter"))
            .map(element => element.dataset.chapter);
        const fireRepeated = async () => {
            for (let i = 0; i < 3; i++) {
                dispatchEvent(new Event("scrollend"));
                await wait(150);
            }
        };

        await fireRepeated();
        for (let i = 0; i < 360 && chapterIds().length < 2; i++) await wait(250);
        await fireRepeated();
        await wait(1000);
        const afterFirst = chapterIds();

        const second = document.querySelectorAll(".hs-chapter")[1];
        const secondImage = second?.querySelector(".hs-reader-img");
        if (secondImage) {
            scrollTo(0, secondImage.offsetTop);
            for (let i = 0; i < 360 && !(secondImage.complete && secondImage.naturalWidth > 0); i++) {
                await wait(250);
            }
            await fireRepeated();
            await wait(250);
            for (let i = 0; i < 360 && chapterIds().length < 3; i++) {
                if (!Array.from(document.querySelectorAll(".hs-loading"))
                    .some(element => element.textContent === "Loading newer chapter...")) break;
                await wait(250);
            }
        }
        await wait(1000);
        return {
            afterFirst,
            final: chapterIds(),
            secondWasLoaded: !!secondImage,
        };
    `;
}

function cancellationAssertions() {
    return `
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        for (let i = 0; i < 360; i++) {
            const state = document.querySelector(".hs-reader-body")?.dataset.restoreState;
            if (state === "cancelled") break;
            await wait(25);
        }
        const body = document.querySelector(".hs-reader-body");
        const scrollAfterCancel = scrollY;
        await wait(1000);
        const scrollAfterWait = scrollY;
        const loadedSaveImage = () => {
            const images = Array.from(document.querySelectorAll(".hs-reader-img"));
            return images.find(image =>
                image.complete &&
                image.naturalWidth > 0 &&
                image.dataset.readerUrl !== location.href
            ) || images.find(image => image.complete && image.naturalWidth > 0);
        };
        let saveImage = loadedSaveImage();
        for (let i = 0; i < 360 && !saveImage; i++) {
            await wait(250);
            saveImage = loadedSaveImage();
        }
        const originalTransform = saveImage?.style.transform ?? "";
        if (saveImage) {
            const desiredTop = innerHeight / 2 - 10;
            saveImage.style.transform = "translateY(" +
                (desiredTop - saveImage.getBoundingClientRect().top) + "px)";
        }
        const hrefBefore = location.href;
        dispatchEvent(new Event("scrollend"));
        await wait(150);
        const result = {
            restoreState: body?.dataset.restoreState ?? null,
            scrollAfterCancel,
            scrollAfterWait,
            hrefBefore,
            hrefAfter: location.href,
            expectedUrl: saveImage?.dataset.readerUrl ?? null,
            saveImageLoaded: !!saveImage?.complete && saveImage.naturalWidth > 0,
        };
        if (saveImage) saveImage.style.transform = originalTransform;
        return result;
    `;
}

function assertRestore(testCase, phase, result) {
    const failures = [];
    if (result.readerBodies !== 1) failures.push(`expected one reader body, got ${result.readerBodies}`);
    if (result.chapterIds?.length !== 1) failures.push(`activation rendered ${result.chapterIds?.length ?? 0} chapters`);
    if (result.targetCount !== 1) failures.push(`expected one provider-decoded restore target, got ${result.targetCount}`);
    if (!result.targetLoaded) failures.push("restore target was not loaded");
    if (result.targetTop === null || Math.abs(result.targetTop) > 1) {
        failures.push(`restore target top was ${result.targetTop}, expected 0 ±1px`);
    }
    if (result.restoreState !== "complete") failures.push(`restore state was ${result.restoreState}`);
    if (result.href !== testCase.url) failures.push(`URL changed to ${result.href}`);
    if (!result.hrefStable) failures.push("URL changed during restoration");
    if (result.targetUrl !== testCase.url) failures.push(`provider target URL was ${result.targetUrl}`);
    if (failures.length) throw new Error(`${phase}: ${failures.join("; ")}`);
}

function assertSave(result) {
    const failures = [];
    if (result.error) failures.push(result.error);
    if (result.beforeDelayElapsed !== result.before) failures.push("URL changed before scrollend + 100ms");
    if (!result.selectedLoaded) failures.push("selected image was incomplete or broken");
    if (!result.expectedUrl) failures.push("provider did not supply a reader URL");
    if (result.href !== result.expectedUrl) failures.push(`saved ${result.href}, expected ${result.expectedUrl}`);
    if (failures.length) throw new Error(`save: ${failures.join("; ")}`);
}

function assertChapters(result) {
    const failures = [];
    if (result.afterFirst?.length !== 2) {
        failures.push(`repeated scrollend on one chapter produced ${result.afterFirst?.length ?? 0} chapters`);
    }
    if (!result.secondWasLoaded) failures.push("newer chapter had no loaded image");
    if (result.final?.length < 2 || result.final?.length > 3) {
        failures.push(`newer visible chapter produced ${result.final?.length ?? 0} total chapters`);
    }
    if (new Set(result.final).size !== result.final?.length) failures.push("a chapter was appended twice");
    if (failures.length) throw new Error(`chapters: ${failures.join("; ")}`);
}

function assertCancellation(result) {
    const failures = [];
    if (result.restoreState !== "cancelled") failures.push(`restore state was ${result.restoreState}`);
    if (Math.abs(result.scrollAfterWait - result.scrollAfterCancel) > 1) {
        failures.push("a pending restore step scrolled after cancellation");
    }
    if (!result.saveImageLoaded) failures.push("no loaded image was available after cancellation");
    if (!result.expectedUrl) failures.push("provider did not supply a URL after cancellation");
    if (result.hrefAfter !== result.expectedUrl) {
        failures.push(`scroll saving resumed with ${result.hrefAfter}, expected ${result.expectedUrl}`);
    }
    if (failures.length) throw new Error(failures.join("; "));
}

async function navigateClaimedTab(testCase) {
    if (!claimedClient) throw new Error("No Safari tab has been claimed");
    const before = await state();
    const known = new Set(before.clients.map(item => item.client));
    await command(claimedClient.client, `
        const target = ${JSON.stringify(testCase.url)};
        if (location.href === target) location.reload();
        else location.href = target;
        return "navigating";
    `);
    claimedClient = await waitForNewClient(known, testCase.url);
    return claimedClient;
}

async function runCase(testCase, bundle) {
    const navigationClient = await navigateClaimedTab(testCase);
    await command(navigationClient.client, injectCode(bundle, testCase.url));
    const restores = [];
    const initial = await command(navigationClient.client, restoreAssertions(testCase.url));
    assertRestore(testCase, "initial restore", initial);
    restores.push(initial);

    const saved = await command(navigationClient.client, saveAssertions());
    assertSave(saved);
    await command(
        navigationClient.client,
        `history.replaceState(null, "", ${JSON.stringify(testCase.url)}); return location.href;`,
    );

    const chapters = await command(navigationClient.client, chapterAssertions());
    assertChapters(chapters);

    let currentClient = navigationClient;
    for (let reload = 1; reload <= 3; reload++) {
        await sleep(casePauseMs);
        const beforeRefresh = await state();
        const known = new Set(beforeRefresh.clients.map(item => item.client));
        await command(
            currentClient.client,
            `history.replaceState(null, "", ${JSON.stringify(testCase.url)}); location.reload(); return "reloading";`,
        );
        currentClient = await waitForNewClient(known, testCase.url);
        claimedClient = currentClient;
        await command(currentClient.client, injectCode(bundle, testCase.url));
        const restored = await command(currentClient.client, restoreAssertions(testCase.url));
        assertRestore(testCase, `reload ${reload}`, restored);
        restores.push(restored);
    }

    await sleep(casePauseMs);
    const beforeCancel = await state();
    const known = new Set(beforeCancel.clients.map(item => item.client));
    await command(
        currentClient.client,
        `history.replaceState(null, "", ${JSON.stringify(testCase.url)}); location.reload(); return "reloading";`,
    );
    const cancelClient = await waitForNewClient(known, testCase.url);
    claimedClient = cancelClient;
    await command(cancelClient.client, injectCode(bundle, testCase.url, { cancelRestore: true }));
    const cancelled = await command(cancelClient.client, cancellationAssertions());
    assertCancellation(cancelled);

    return { initial, restores, saved, chapters, cancelled };
}

async function main() {
    await ensureServer();
    await waitForDebugger();
    console.log("iPhone debugger connected.");
    await claimExampleTab();

    checkAndBuild();

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
            console.log(`PASS (${result.chapters.final.join(" → ")}, four idempotent restorations)`);
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
} catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
} finally {
    if (ownedServer && ownedServer.exitCode === null) ownedServer.kill();
}
