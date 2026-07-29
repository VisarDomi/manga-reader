#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
    createController,
    createSession,
    parseSelection,
    phaseBannerScript,
    runBuildSteps,
    runCaseMatrix,
} from "userscript-ios-test/controller";

const root = resolve(import.meta.dirname, "../..");
const iosConfig = JSON.parse(
    await readFile(resolve(root, "tests/ios/config.json"), "utf8"),
);
const casePauseMs = Math.max(500, Number(process.env.IOS_TEST_SETTLE_MS ?? 500));
const controller = createController({
    root,
    name: iosConfig.name,
    debuggerName: iosConfig.debuggerName,
    port: iosConfig.port,
    settleMs: casePauseMs,
    commandTimeoutMs: Number(process.env.IOS_TEST_COMMAND_TIMEOUT_MS ?? 90000),
    clientTimeoutMs: Number(process.env.IOS_TEST_CLIENT_TIMEOUT_MS ?? 45000),
    connectionTimeoutMs: Number(process.env.IOS_TEST_CONNECTION_TIMEOUT_MS ?? 120000),
});
const session = createSession({
    controller,
    sourceLabel: "manga-reader.test.user.js",
});
const command = (_client, code, options) => session.command(code, options);

function checkAndBuild() {
    runBuildSteps(controller, [
        ["npx", ["tsc", "--noEmit"]],
        ["node", ["scripts/build.mjs", "--no-increase-version"]],
    ]);
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
        ${phaseBannerScript({
            globalName: "__mangaReaderTestPhase",
            elementId: "__manga-reader-test-phase",
        })}
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
    return session.navigate(testCase.url, {
        matches: (candidate, expected) =>
            navigationMatches(candidate.href, expected),
    });
}

async function showPhase(_client, text, state = "running") {
    await session.showPhase({
        globalName: "__mangaReaderTestPhase",
        text,
        state,
        pauseMs: casePauseMs,
    });
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

    const restoredClient = await session.reload(saved.href, {
        before: `
            globalThis.__mangaReaderTestPhase?.("3/4 Reloading saved position");
            await new Promise(resolve => setTimeout(resolve, ${casePauseMs}));
        `,
        matches: (candidate, expected) =>
            navigationMatches(candidate.href, expected),
    });
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
    const selection = parseSelection(process.argv.slice(2));
    const testName = selection.test;
    const siteName = selection.site;
    if (!["full", "tracking"].includes(testName)) {
        throw new Error(`Unknown test "${testName}". Expected "full" or "tracking".`);
    }
    if (testName === "tracking" && siteName !== "asura") {
        throw new Error('The "tracking" test requires --site asura.');
    }
    const requestedUrls = selection.args;
    if (requestedUrls.some(url => !/^https?:\/\//.test(url))) {
        throw new Error("Each test argument must be a complete http(s) URL");
    }

    const frozenMatrixText = await readFile(resolve(root, "test.txt"), "utf8");
    const providerHosts = new Set(
        [...frozenMatrixText.matchAll(/https?:\/\/[^\s]+/g), ...requestedUrls.map(url => [url])]
            .map(match => new URL(match[0]).hostname),
    );
    await session.connect({
        allowedHosts: [...providerHosts],
        controlledCode: `
            return Boolean(
                globalThis.__mangaReaderTestPhase ||
                document.querySelector(".hs-reader-body")
            );
        `,
    });
    console.log("iPhone debugger connected.");

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
    const { failures } = await runCaseMatrix({
        cases,
        pauseMs: casePauseMs,
        run: async testCase => {
            if (testName === "tracking") {
                return runTrackingCase(testCase, bundle);
            }
            return runCase(testCase, bundle);
        },
        formatPass: result => testName === "tracking"
            ? `PASS (tracked once each: ${result.chapterIds.slice(0, 2).join(" → ")})`
            : `PASS (${result.chapters.final.join(" → ")}, saved ${result.saved.chapterId}${result.saved.imageId} restored)`,
        onFailure: async ({ message }) => {
            if (session.client) {
                try {
                    await command(
                        session.client.client,
                        `globalThis.__mangaReaderTestPhase?.(${JSON.stringify(`TEST FAILED: ${message}`)}, "error"); return true;`,
                    );
                } catch {
                    // The failed page may already have navigated away.
                }
            }
        },
    });

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
    await session.cleanup();
    session.close();
}
