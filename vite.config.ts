import { defineConfig, loadEnv } from "vite";
import monkey from "vite-plugin-monkey";
import pkg from "./package.json";
import { SITE_CONFIG, userscriptMatch } from "./src/core/sites";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from 'node:fs';

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
const env = loadEnv('production', process.cwd(), '');
const backupUrl = env.VITE_READER_BACKUP_URL ?? 'https://192.168.1.197:7777';
const backupKey = env.VITE_READER_BACKUP_KEY || readFileSync(new URL('../gallery-downloader/backups/readers/access-key', import.meta.url), 'utf8').trim();

export default defineConfig({
    define: { __READER_BACKUP_URL__: JSON.stringify(backupUrl), __READER_BACKUP_KEY__: JSON.stringify(backupKey) },
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
                connect: [new URL(backupUrl).hostname],
            },
            build: {
                fileName: buildName ? `${buildName}.user.js` : undefined,
            },
        }),
    ],
});
