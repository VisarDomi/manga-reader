import { defineConfig } from "vite";
import monkey from "vite-plugin-monkey";
import pkg from "./package.json";

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
                name: `${pkg.name} v${pkg.version}`,
                namespace: "https://github.com/VisarDomi",
                description: "manga reader takeover",
                match: [
                    "https://ezmanga.org/*",
                    "https://qimanga.com/*",
                    "https://valirscans.org/*",
                    "https://yakshacomics.com/*",
                    "https://davemangascans.xyz/*",
                    "https://cubari.moe/read/gist/*"
                ],
                "run-at": "document-start",
            },
        }),
    ],
});
