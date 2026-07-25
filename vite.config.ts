import { defineConfig } from "vite";
import monkey from "vite-plugin-monkey";
import pkg from "./package.json";
import { SITE_CONFIG, userscriptMatch } from "./src/sites";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getMatchPatterns(): string[] {
    const raw = process.env.MATCH_SITES;
    const allSites = Object.keys(SITE_CONFIG);
    if (!raw) return allSites.map(s => userscriptMatch(s));
    return raw.split(',').map(s => {
        if (!allSites.includes(s)) throw new Error(`Unknown site: ${s}`);
        return userscriptMatch(s);
    });
}

const buildName = process.env.BUILD_NAME || '';
const excluded = (process.env.EXCLUDE_PROVIDERS || '').split(',').filter(Boolean);

export default defineConfig({
    build: {
        minify: false,
        sourcemap: false,
        target: "esnext",
        modulePreload: false,
        cssCodeSplit: false,
        emptyOutDir: false,
    },
    resolve: {
        alias: excluded.map(name => ({
            find: new RegExp(`^\.\/${name}$`),
            replacement: resolve(__dirname, 'src/provider/_empty.ts'),
        })),
    },
    plugins: [
        monkey({
            entry: "src/main.ts",
            userscript: {
                name: `${buildName || pkg.name} v${pkg.version}`,
                namespace: "https://github.com/VisarDomi",
                description: "manga reader takeover",
                match: getMatchPatterns(),
                "run-at": "document-start",
            },
            build: {
                fileName: buildName ? `${buildName}.user.js` : undefined,
            },
        }),
    ],
});
