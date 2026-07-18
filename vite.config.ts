import { defineConfig } from "vite";
import monkey from "vite-plugin-monkey";
import pkg from "./package.json";
import { Site, userscriptMatch } from "./src/sites";

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
                match: Object.values(Site).map(userscriptMatch),
                "run-at": "document-start",
            },
        }),
    ],
});
