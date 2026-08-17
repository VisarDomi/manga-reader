#!/usr/bin/env node
// Dump the app's progress store keys from the phone.
import { createController, createSession, sleep } from "userscript-ios-test/controller";

const root = new URL("..", import.meta.url).pathname;
const controller = createController({
    root,
    name: "manga-reader-valir-dump",
    connectionTimeoutMs: 60_000,
    commandTimeoutMs: 30_000,
    clientTimeoutMs: 30_000,
    settleMs: 2_000,
});
const session = createSession({ controller, sourceLabel: "manga-reader-valir-dump.user.js" });

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

const DUMP = String.raw`
    return await new Promise(resolve => {
        const open = indexedDB.open("manga-reader-compute");
        open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction("progress", "readonly");
            const req = tx.objectStore("progress").getAll();
            req.onsuccess = () => {
                const entries = req.result ?? [];
                resolve({
                    count: entries.length,
                    samples: entries.slice(0, 8).map(e => ({ id: e.id, chapterId: e.chapterId, imageIndex: e.imageIndex, total: e.totalImages })),
                });
                db.close();
            };
            req.onerror = () => { resolve({ error: String(req.error) }); db.close(); };
        };
        open.onerror = () => resolve({ error: String(open.error) });
    });
`;

const log = payload => console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 19), ...payload }));

try {
    await session.connect({
        allowedHosts: ["valirscans.org"],
        controlledCode: `return Boolean(document.querySelector(".hs-home") || document.querySelector(".hs-reader-body"));`,
    });
    await session.navigate("https://valirscans.org/", {
        matches: (candidate, expected) => navigationMatches(candidate.href, expected),
    });
    await sleep(3000);
    const fg = await controller.foregroundClient();
    log({ step: "dump", result: await controller.command(fg.client, DUMP) });
} finally {
    await session.cleanup().catch(error => log({ step: "cleanup-warning", error: String(error) }));
    session.close();
}
