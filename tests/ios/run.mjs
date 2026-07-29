#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import https from "node:https";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const bridgeOrigin = process.env.IOS_DEBUG_ORIGIN ?? "https://127.0.0.1:37777";
const casePauseMs = Math.max(500, Number(process.env.IOS_TEST_SETTLE_MS ?? 500));
const commandTimeoutMs = Number(process.env.IOS_TEST_COMMAND_TIMEOUT_MS ?? 90000);
const clientTimeoutMs = Number(process.env.IOS_TEST_CLIENT_TIMEOUT_MS ?? 45000);
const connectionTimeoutMs = Number(process.env.IOS_TEST_CONNECTION_TIMEOUT_MS ?? 120000);
const agent = new https.Agent({ rejectUnauthorized: false });
let ownedServer = null;
let claimedClient = null;
let lastNavigationAt = 0;

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

async function navigationCommand(target, code) {
    const remainingPause = lastNavigationAt + casePauseMs - Date.now();
    if (remainingPause > 0) await sleep(remainingPause);
    lastNavigationAt = Date.now();
    return command(target, code);
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

async function claimExampleTab(providerHosts) {
    let client = await foregroundClient();
    const foregroundUrl = new URL(client.href);
    if (foregroundUrl.hostname !== "example.com") {
        const controlled = await command(client.client, `
            return Boolean(
                globalThis.__mangaReaderTestPhase ||
                document.querySelector(".hs-reader-body")
            );
        `);
        if (!controlled && !providerHosts.has(foregroundUrl.hostname)) {
            throw new Error(
                "The foreground Safari tab is unrelated to the current test session.\n" +
                "Open https://example.com once so the harness can claim it safely.\n" +
                `Foreground tab is currently: ${client.href}`,
            );
        }

        const snapshot = await state();
        const known = new Set(snapshot.clients.map(item => item.client));
        console.log(`Returning controlled tab from ${client.href} to https://example.com/.`);
        await navigationCommand(
            client.client,
            `location.href = "https://example.com/"; return "navigating";`,
        );
        client = await waitForNewClient(known, "https://example.com/");
    }

    claimedClient = client;
    console.log(`Claimed foreground Safari tab at ${client.href}.`);
}

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

async function waitForNewClient(knownClients, expectedUrl) {
    const deadline = Date.now() + clientTimeoutMs;
    while (Date.now() < deadline) {
        const snapshot = await state();
        const client = [...snapshot.clients]
            .filter(item =>
                !knownClients.has(item.client) &&
                navigationMatches(item.href, expectedUrl)
            )
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

function injectCode(bundle, url, { trackAsura = false } = {}) {
    return `
        history.replaceState(null, "", ${JSON.stringify(url)});
        ${trackAsura ? `
        globalThis.__mangaReaderTrackingCalls = [];
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (input, init) => {
            const url = typeof input === "string" ? input : input.url;
            const pathname = new URL(url, location.href).pathname;
            if (pathname.startsWith("/api/bookmarks/") || pathname === "/api/views/chapter") {
                globalThis.__mangaReaderTrackingCalls.push({
                    pathname,
                    body: init?.body ? JSON.parse(init.body) : null,
                });
                return Promise.resolve(new Response("{}", {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                }));
            }
            return originalFetch(input, init);
        };
        ` : ""}
        globalThis.__mangaReaderTestPhase = (text, state = "running") => {
            let box = document.getElementById("__manga-reader-test-phase");
            if (!box) {
                box = document.createElement("div");
                box.id = "__manga-reader-test-phase";
                Object.assign(box.style, {
                    position: "fixed",
                    zIndex: "2147483647",
                    top: "12px",
                    left: "12px",
                    right: "12px",
                    padding: "14px 16px",
                    borderRadius: "12px",
                    color: "white",
                    font: "700 18px/1.3 system-ui, sans-serif",
                    textAlign: "center",
                    boxShadow: "0 4px 20px #0009",
                    pointerEvents: "none",
                });
                (document.body || document.documentElement).appendChild(box);
            }
            box.style.background = state === "success"
                ? "#15803d"
                : state === "error" ? "#b91c1c" : "#1d4ed8";
            box.textContent = text;
        };
        const source = ${JSON.stringify(bundle)};
        new Function(source + String.fromCharCode(10) + "//# sourceURL=manga-reader.test.user.js")();
        globalThis.__mangaReaderTestPhase(${JSON.stringify(
            trackAsura ? "Testing once-per-chapter tracking" : "1/4 Restoring requested position",
        )});
        return { injectedBytes: source.length };
    `;
}

function positionSnapshot() {
    return `
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const current = () => Array.from(document.querySelectorAll(".hs-reader-img"))
            .filter(image => image.complete && image.naturalWidth > 0)
            .map(image => ({
                image,
                top: image.getBoundingClientRect().top,
            }))
            .sort((a, b) => Math.abs(a.top) - Math.abs(b.top))[0];
        for (let i = 0; i < 360; i++) {
            const item = current();
            if (item && Math.abs(item.top) <= 1) break;
            await wait(250);
        }
        const item = current();
        const chapter = item?.image.closest(".hs-chapter");
        return {
            readerBodies: document.querySelectorAll(".hs-reader-body").length,
            chapterIds: Array.from(document.querySelectorAll(".hs-chapter")).map(element => element.dataset.chapter),
            imageId: item?.image.id ?? null,
            chapterId: chapter?.dataset.chapter ?? null,
            imageLoaded: !!item?.image.complete && item.image.naturalWidth > 0,
            imageTop: item?.top ?? null,
            href: location.href,
        };
    `;
}

function saveNextPosition(chapterId, imageId) {
    return `
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        globalThis.__mangaReaderTestPhase?.("2/4 Scrolling naturally to the next image");
        const chapter = Array.from(document.querySelectorAll(".hs-chapter"))
            .find(element => element.dataset.chapter === ${JSON.stringify(chapterId)});
        const images = Array.from(chapter?.querySelectorAll(".hs-reader-img") || []);
        const currentIndex = images.findIndex(image => image.id === ${JSON.stringify(imageId)});
        const target = images[currentIndex + 1];
        if (!target) return { error: "restored image has no next image to test" };
        const before = location.href;

        const scrollAndWait = top => new Promise(resolve => {
            const timeout = setTimeout(finish, 5000);
            function finish() {
                clearTimeout(timeout);
                removeEventListener("scrollend", finish);
                resolve();
            }
            addEventListener("scrollend", finish, { once: true });
            scrollTo(0, top);
        });

        target.loading = "eager";
        for (let i = 0; i < 360 && !(target.complete && target.naturalWidth > 0); i++) {
            await wait(250);
        }
        const timing = new Promise(resolve => {
            const timeout = setTimeout(() => resolve({
                at50ms: location.href,
                href: location.href,
            }), 5000);
            addEventListener("scrollend", () => {
                setTimeout(() => {
                    const at50ms = location.href;
                    setTimeout(() => {
                        clearTimeout(timeout);
                        resolve({ at50ms, href: location.href });
                    }, 100);
                }, 50);
            }, { once: true });
        });
        await scrollAndWait(target.offsetTop - innerHeight / 2 + 10);
        const measured = await timing;

        return {
            before,
            at50ms: measured.at50ms,
            href: measured.href,
            imageId: target.id,
            chapterId: chapter?.dataset.chapter ?? null,
            imageLoaded: target.complete && target.naturalWidth > 0,
        };
    `;
}

function chapterAssertions() {
    return `
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        globalThis.__mangaReaderTestPhase?.("4/4 Loading one newer chapter per visible chapter");
        const chapterIds = () => Array.from(document.querySelectorAll(".hs-chapter"))
            .map(element => element.dataset.chapter);
        const scrollAndWait = top => new Promise(resolve => {
            const timeout = setTimeout(finish, 5000);
            function finish() {
                clearTimeout(timeout);
                removeEventListener("scrollend", finish);
                setTimeout(resolve, 150);
            }
            addEventListener("scrollend", finish, { once: true });
            scrollTo(0, top);
        });
        const waitForChapterCount = async count => {
            for (let i = 0; i < 40 && chapterIds().length < count; i++) {
                if (i > 1 && !document.querySelector(".hs-loading")) break;
                await wait(250);
            }
        };

        const initial = chapterIds();
        await scrollAndWait(scrollY + 100);
        await waitForChapterCount(initial.length + 1);
        const afterFirst = chapterIds();

        await scrollAndWait(scrollY + 100);
        await wait(500);
        const afterRepeated = chapterIds();

        const chapters = document.querySelectorAll(".hs-chapter");
        const last = chapters[chapters.length - 1];
        const lastImage = last?.querySelector(".hs-reader-img");
        if (lastImage) {
            await scrollAndWait(lastImage.offsetTop);
            for (let i = 0; i < 360 && !(lastImage.complete && lastImage.naturalWidth > 0); i++) {
                await wait(250);
            }
            await scrollAndWait(lastImage.offsetTop + 100);
            await waitForChapterCount(afterRepeated.length + 1);
        }
        return {
            initial,
            afterFirst,
            afterRepeated,
            final: chapterIds(),
            lastWasLoaded: !!lastImage?.complete && lastImage.naturalWidth > 0,
        };
    `;
}

function assertPosition(expected, phase, result) {
    const failures = [];
    if (result.readerBodies !== 1) failures.push(`expected one reader body, got ${result.readerBodies}`);
    if (!result.chapterIds?.length) failures.push("no chapter rendered");
    if (!result.imageLoaded) failures.push("restored image was incomplete or broken");
    if (result.imageTop === null || Math.abs(result.imageTop) > 1) {
        failures.push(`restored image top was ${result.imageTop}, expected 0 ±1px`);
    }
    if (expected.href && result.href !== expected.href) failures.push(`URL changed to ${result.href}`);
    if (expected.imageId && result.imageId !== expected.imageId) {
        failures.push(`restored ${result.imageId}, expected ${expected.imageId}`);
    }
    if (expected.chapterId && result.chapterId !== expected.chapterId) {
        failures.push(`restored chapter ${result.chapterId}, expected ${expected.chapterId}`);
    }
    if (failures.length) throw new Error(`${phase}: ${failures.join("; ")}`);
}

function assertSave(result) {
    const failures = [];
    if (result.error) failures.push(result.error);
    if (result.at50ms !== result.before) failures.push("URL changed before scrollend + 100ms");
    if (!result.imageLoaded) failures.push("saved image was incomplete or broken");
    if (result.href === result.before) failures.push("provider URL did not change after saving");
    if (failures.length) throw new Error(`save: ${failures.join("; ")}`);
}

function assertChapters(result) {
    const failures = [];
    if (result.afterFirst?.length > result.initial?.length + 1) {
        failures.push("one visible chapter appended more than one newer chapter");
    }
    if (result.afterRepeated?.length !== result.afterFirst?.length) {
        failures.push("repeated scrolling on one visible chapter appended another chapter");
    }
    if (result.final?.length > result.afterRepeated?.length + 1) {
        failures.push("the next visible chapter appended more than one newer chapter");
    }
    if (new Set(result.final).size !== result.final?.length) failures.push("a chapter was appended twice");
    if (!result.lastWasLoaded) failures.push("visible chapter had no loaded image");
    if (failures.length) throw new Error(`chapters: ${failures.join("; ")}`);
}

function trackingAssertions() {
    return `
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const scrollAndWait = top => new Promise(resolve => {
            const timeout = setTimeout(finish, 5000);
            function finish() {
                clearTimeout(timeout);
                removeEventListener("scrollend", finish);
                setTimeout(resolve, 150);
            }
            addEventListener("scrollend", finish, { once: true });
            scrollTo(0, top);
        });
        const waitFor = async predicate => {
            for (let i = 0; i < 80; i++) {
                if (predicate()) return true;
                await wait(250);
            }
            return false;
        };
        const chapters = () => Array.from(document.querySelectorAll(".hs-chapter"));
        const images = chapter => Array.from(chapter?.querySelectorAll(".hs-reader-img") || []);
        const isLoaded = image => image?.complete && image.naturalWidth > 0;
        const readImages = async selected => {
            for (const image of selected) {
                if (!await waitFor(() => isLoaded(image))) return false;
                await scrollAndWait(image.offsetTop + image.offsetHeight - innerHeight);
            }
            return true;
        };

        const firstChapter = chapters()[0];
        const currentImageIndex = Math.max(
            0,
            images(firstChapter).findIndex(image => image.id === location.hash),
        );
        const currentImage = images(firstChapter)[currentImageIndex];
        if (!await waitFor(() =>
            isLoaded(currentImage) &&
            Math.abs(currentImage.getBoundingClientRect().top) <= 1
        )) {
            return { error: "reader did not finish restoring the current image" };
        }
        await wait(250);
        if (!await readImages(images(firstChapter).slice(currentImageIndex))) {
            return { error: "first chapter images did not load naturally" };
        }

        if (!await waitFor(() => chapters().length >= 2)) {
            return { error: "a second chapter was not loaded" };
        }
        const secondChapter = chapters()[1];
        if (!await readImages(images(secondChapter).slice(0, 2))) {
            return { error: "second chapter images did not load naturally" };
        }

        return {
            chapterIds: chapters().map(chapter => chapter.dataset.chapter),
            calls: globalThis.__mangaReaderTrackingCalls,
        };
    `;
}

function assertTracking(result) {
    if (result.error) throw new Error(`tracking: ${result.error}`);
    const failures = [];
    if (result.chapterIds?.length < 2) failures.push("a second chapter was not loaded");

    const bookmarks = result.calls?.filter(call => call.pathname.startsWith("/api/bookmarks/")) ?? [];
    const views = result.calls?.filter(call => call.pathname === "/api/views/chapter") ?? [];
    const bookmarkChapters = bookmarks.map(call => call.pathname.split("/").at(-1));
    const viewChapters = views.map(call => call.body?.chapter_id);

    if (bookmarks.length !== 2) failures.push(`expected 2 bookmark calls, got ${bookmarks.length}`);
    if (views.length !== 2) failures.push(`expected 2 view calls, got ${views.length}`);
    if (new Set(bookmarkChapters).size !== 2) failures.push("a chapter was bookmarked more than once");
    if (new Set(viewChapters).size !== 2) failures.push("a chapter view was tracked more than once");
    if (failures.length) throw new Error(`tracking: ${failures.join("; ")}`);
}

async function navigateClaimedTab(testCase) {
    if (!claimedClient) throw new Error("No Safari tab has been claimed");
    const before = await state();
    const known = new Set(before.clients.map(item => item.client));
    await navigationCommand(claimedClient.client, `
        const target = ${JSON.stringify(testCase.url)};
        if (location.href === target) location.reload();
        else location.href = target;
        return "navigating";
    `);
    claimedClient = await waitForNewClient(known, testCase.url);
    return claimedClient;
}

async function showPhase(client, text, state = "running") {
    await command(
        client.client,
        `globalThis.__mangaReaderTestPhase?.(${JSON.stringify(text)}, ${JSON.stringify(state)}); return true;`,
    );
    await sleep(casePauseMs);
}

async function runCase(testCase, bundle) {
    const navigationClient = await navigateClaimedTab(testCase);
    await command(navigationClient.client, injectCode(bundle, testCase.url));
    const initial = await command(navigationClient.client, positionSnapshot());
    assertPosition({ href: testCase.url }, "initial restore", initial);
    await showPhase(
        navigationClient,
        `1/4 Restore complete at ${initial.chapterId}${initial.imageId}`,
    );

    const saved = await command(
        navigationClient.client,
        saveNextPosition(initial.chapterId, initial.imageId),
    );
    assertSave(saved);
    await showPhase(
        navigationClient,
        `2/4 Save complete at ${saved.chapterId}${saved.imageId}`,
    );

    const beforeRefresh = await state();
    const known = new Set(beforeRefresh.clients.map(item => item.client));
    await navigationCommand(
        navigationClient.client,
        `
            globalThis.__mangaReaderTestPhase?.("3/4 Reloading saved position");
            await new Promise(resolve => setTimeout(resolve, ${casePauseMs}));
            history.replaceState(null, "", ${JSON.stringify(saved.href)});
            location.reload();
            return "reloading";
        `,
    );
    const restoredClient = await waitForNewClient(known, saved.href);
    claimedClient = restoredClient;
    await command(restoredClient.client, injectCode(bundle, saved.href));
    await command(
        restoredClient.client,
        `globalThis.__mangaReaderTestPhase?.("3/4 Restoring saved position"); return true;`,
    );
    const restored = await command(restoredClient.client, positionSnapshot());
    assertPosition({
        imageId: saved.imageId,
        chapterId: saved.chapterId,
    }, "saved URL restore", restored);
    await showPhase(
        restoredClient,
        `3/4 Saved position restored at ${restored.chapterId}${restored.imageId}`,
    );

    const chapters = await command(restoredClient.client, chapterAssertions());
    assertChapters(chapters);
    await showPhase(
        restoredClient,
        `4/4 Chapters loaded: ${chapters.final.join(" → ")}`,
    );
    await command(restoredClient.client, `
        globalThis.__mangaReaderTestPhase?.("TEST SUCCESSFUL", "success");
        return true;
    `);

    return { initial, restored, saved, chapters };
}

async function runTrackingCase(testCase, bundle) {
    const navigationClient = await navigateClaimedTab(testCase);
    await command(
        navigationClient.client,
        injectCode(bundle, testCase.url, { trackAsura: true }),
    );
    const result = await command(navigationClient.client, trackingAssertions());
    assertTracking(result);
    await command(navigationClient.client, `
        globalThis.__mangaReaderTestPhase?.("TRACKING TEST SUCCESSFUL", "success");
        return true;
    `);
    return result;
}

async function main() {
    const args = process.argv.slice(2);
    function takeOption(name, fallback) {
        const index = args.indexOf(name);
        if (index === -1) return fallback;
        const value = args[index + 1];
        if (!value || value.startsWith("--")) {
            throw new Error(`${name} requires a value`);
        }
        args.splice(index, 2);
        return value;
    }

    const testName = takeOption("--test", "full");
    const siteName = takeOption("--site", null);
    if (!["full", "tracking"].includes(testName)) {
        throw new Error(`Unknown test "${testName}". Expected "full" or "tracking".`);
    }
    if (testName === "tracking" && siteName !== "asura") {
        throw new Error('The "tracking" test requires --site asura.');
    }
    const requestedUrls = args;
    if (requestedUrls.some(url => !/^https?:\/\//.test(url))) {
        throw new Error("Each test argument must be a complete http(s) URL");
    }

    await ensureServer();
    await waitForDebugger();
    console.log("iPhone debugger connected.");
    const frozenMatrixText = await readFile(resolve(root, "test.txt"), "utf8");
    const providerHosts = new Set(
        [...frozenMatrixText.matchAll(/https?:\/\/[^\s]+/g), ...requestedUrls.map(url => [url])]
            .map(match => new URL(match[0]).hostname),
    );
    await claimExampleTab(providerHosts);

    checkAndBuild();

    const [matrixText, bundle] = await Promise.all([
        requestedUrls.length
            ? requestedUrls.join("\n")
            : frozenMatrixText,
        readFile(resolve(root, "dist/manga-reader.user.js"), "utf8"),
    ]);
    let cases = matrixText
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => /^https?:\/\//.test(line))
        .map(describeCase);
    if (siteName) {
        const siteConfig = JSON.parse(
            await readFile(resolve(root, "src/core/sites.json"), "utf8"),
        );
        cases = cases.filter(testCase => {
            const hostname = new URL(testCase.url).hostname;
            return Object.entries(siteConfig).some(([key, config]) =>
                config.domain === hostname &&
                (siteName === key || siteName === config.provider)
            );
        });
    }

    if (!cases.length) {
        throw new Error(
            siteName
                ? `No test URL found for site "${siteName}"`
                : "No test URLs were supplied",
        );
    }

    console.log(`iOS Safari ${testName} test: ${cases.length} cases; ${casePauseMs}ms minimum pause between phases/cases`);
    const failures = [];

    for (const [index, testCase] of cases.entries()) {
        if (index > 0) await sleep(casePauseMs);
        process.stdout.write(`[${index + 1}/${cases.length}] ${testCase.name} ... `);
        try {
            if (testName === "tracking") {
                const result = await runTrackingCase(testCase, bundle);
                console.log(`PASS (tracked once each: ${result.chapterIds.slice(0, 2).join(" → ")})`);
            } else {
                const result = await runCase(testCase, bundle);
                console.log(
                    `PASS (${result.chapters.final.join(" → ")}, saved ${result.saved.chapterId}${result.saved.imageId} restored)`,
                );
            }
        } catch (error) {
            failures.push({ name: testCase.name, error });
            const message = error instanceof Error ? error.message : String(error);
            if (claimedClient) {
                try {
                    await command(
                        claimedClient.client,
                        `globalThis.__mangaReaderTestPhase?.(${JSON.stringify(`TEST FAILED: ${message}`)}, "error"); return true;`,
                    );
                } catch {
                    // The failed page may already have navigated away.
                }
            }
            console.log(`FAIL\n    ${message}`);
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
