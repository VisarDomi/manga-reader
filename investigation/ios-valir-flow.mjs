#!/usr/bin/env node
// Catch the full valir partial flow on the phone: session state, the exact
// reading-position POST, and what continue-reading reflects afterward.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createController, createSession, sleep } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const bundle = await readFile(resolve(root, "dist/manga-reader.user.js"), "utf8");
const URL16 = "https://valirscans.org/series/comic/my-tyrant-brother-is-a-bonus/chapter/16#2";

const controller = createController({
    root,
    name: "manga-reader-valir-flow",
    connectionTimeoutMs: 60_000,
    commandTimeoutMs: 45_000,
    clientTimeoutMs: 30_000,
    settleMs: 2_000,
});
const session = createSession({ controller, sourceLabel: "manga-reader-valir-flow.user.js" });

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

function injectCode(url) {
    const parts = [
        "history.replaceState(null, \"\", " + JSON.stringify(url) + ");\n",
        "const source = " + JSON.stringify(bundle) + ";\n",
        "new Function(source + String.fromCharCode(10) + \"//# sourceURL=valir-flow.user.js\")();\n",
        "return { injectedBytes: source.length };",
    ];
    return parts.join("");
}

const log = payload => console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 19), ...payload }));

try {
    await session.connect({
        allowedHosts: ["valirscans.org"],
        controlledCode: `return Boolean(document.querySelector(".hs-home") || document.querySelector(".hs-reader-body"));`,
    });
    await session.navigate(URL16, { matches: (candidate, expected) => navigationMatches(candidate.href, expected) });
    await sleep(3000);
    const fg = await controller.foregroundClient();
    await controller.command(fg.client, injectCode(URL16), { expectResult: false });
    await sleep(12000);
    const fg2 = await controller.foregroundClient();

    const flow = await controller.command(fg2.client, String.raw`
        const out = {};
        // 1. session state
        const sessionRes = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
        out.sessionStatus = sessionRes.status;
        const sessionJson = await sessionRes.json().catch(() => null);
        out.sessionUser = sessionJson && typeof sessionJson.user === "object" && sessionJson.user !== null
            ? Object.keys(sessionJson.user).slice(0, 6)
            : null;
        out.cookies = document.cookie.split(";").map(s => s.trim().split("=")[0]).filter(Boolean);

        // 2. ids from the chapter RSC
        const pageRes = await fetch(location.pathname, { credentials: "same-origin" });
        const html = await pageRes.text();
        const seriesMatch = /\\"series\\":\s*\{[^}]*\\"id\\":\s*\\"([^"\\]+)\\"/.exec(html);
        const chapterMatch = /\\"chapter\\":\s*\{[^}]*\\"id\\":\s*\\"([^"\\]+)\\"/.exec(html);
        out.seriesId = seriesMatch ? seriesMatch[1] : null;
        out.chapterApiId = chapterMatch ? chapterMatch[1] : null;

        // 3. our exact reading-position POST
        if (out.seriesId && out.chapterApiId) {
            const body = JSON.stringify({
                seriesId: out.seriesId,
                chapters: [{ chapterId: out.chapterApiId, progress: 40 }],
            });
            const post = await fetch("/api/chapters/reading-position", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body,
                credentials: "same-origin",
            });
            out.postStatus = post.status;
            out.postBody = (await post.text()).slice(0, 200);
        }

        // 4. what continue-reading reflects
        const cr = await fetch("/api/continue-reading", { credentials: "same-origin", cache: "no-store" });
        out.continueStatus = cr.status;
        const crJson = await cr.json().catch(() => null);
        const series = crJson && Array.isArray(crJson.series)
            ? crJson.series.find(s => s.urlSlug === "my-tyrant-brother-is-a-bonus" || s.slug === "my-tyrant-brother-is-a-bonus")
            : null;
        out.continueSeries = series ? {
            lastChapter: series.lastChapter ? { number: series.lastChapter.number, progress: series.lastChapter.progress } : null,
            highestChapter: series.highestChapter,
        } : null;
        return out;
    `);
    log({ step: "flow", flow });

    // 5. trigger the app's own tracking via a scroll pause.
    const scroll = await controller.command(fg2.client, String.raw`
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const settled = new Promise(resolve => addEventListener("scrollend", resolve, { once: true }));
        scrollTo(0, scrollY + 700);
        await Promise.race([settled, wait(3000)]);
        await wait(1200);
        return { href: location.href, syncError: document.querySelector(".hs-error")?.textContent ?? null };
    `);
    log({ step: "app-scroll", scroll });
    await sleep(3000);

    const cr2 = await controller.command(fg2.client, String.raw`
        const cr = await fetch("/api/continue-reading", { credentials: "same-origin", cache: "no-store" });
        const crJson = await cr.json().catch(() => null);
        const series = crJson && Array.isArray(crJson.series)
            ? crJson.series.find(s => s.urlSlug === "my-tyrant-brother-is-a-bonus" || s.slug === "my-tyrant-brother-is-a-bonus")
            : null;
        return series ? { lastChapter: series.lastChapter, highestChapter: series.highestChapter } : null;
    `);
    log({ step: "continue-after-scroll", cr2 });
} finally {
    await session.cleanup().catch(error => log({ step: "cleanup-warning", error: String(error) }));
    session.close();
}
