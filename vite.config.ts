import { defineConfig } from "vite";
import monkey from "vite-plugin-monkey";
import pkg from "./package.json";
import { Site, SITE_CONFIG, userscriptMatch } from "./src/sites";

function getMatchPatterns(): string[] {
    const raw = process.env.MATCH_SITES;
    if (!raw) return Object.values(Site).map(userscriptMatch);
    return raw.split(',').map(s => {
        const site = (Object.values(Site) as Site[]).find(site => site === s.trim());
        if (!site) throw new Error(`Unknown site: ${s}`);
        return userscriptMatch(site);
    });
}

export default defineConfig({
    build: {
        minify: false,
        sourcemap: false,
        target: "esnext",
        modulePreload: false,
        cssCodeSplit: false,
    },
    plugins: [
        monkey({
            entry: "src/main.ts",
            userscript: {
                name: `${process.env.BUILD_NAME || pkg.name} v${pkg.version}`,
                namespace: "https://github.com/VisarDomi",
                description: "manga reader takeover",
                match: getMatchPatterns(),
                "run-at": "document-start",
            },
        }),
    ],
});
