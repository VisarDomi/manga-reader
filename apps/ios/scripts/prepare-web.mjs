// Share the actual userscript rules; do not maintain a second settling/retry policy.
import fs from 'node:fs';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
const root = new URL('../../../', import.meta.url);
const web = new URL('../Resources/Web/', import.meta.url);
await build({
  configFile: false, logLevel: 'error',
  build: {
    outDir: fileURLToPath(web), emptyOutDir: false, minify: false,
    lib: { entry: fileURLToPath(new URL('../Resources/reader-core.ts', import.meta.url)), name: 'ReaderCore', formats: ['iife'], fileName: () => 'reader-core.js' },
  },
});
const cssFile = new URL('style.css', web);
const css = fs.readFileSync(cssFile, 'utf8');
const marker = '/* Native-only mechanics.';
fs.writeFileSync(cssFile, fs.readFileSync(new URL('src/style.css', root), 'utf8') + '\n' + css.slice(css.indexOf(marker)));
