// Share the actual userscript rules; do not maintain a second settling/retry policy.
import fs from 'node:fs';
import ts from 'typescript';
const root = new URL('../../../', import.meta.url);
const web = new URL('../Resources/Web/', import.meta.url);
const sources = ['src/core/scroll-settle.ts', 'src/core/image-retry.ts'];
const code = sources.map(path => fs.readFileSync(new URL(path, root), 'utf8').replace(/^export /gm, '')).join('\n');
const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
fs.writeFileSync(new URL('reader-core.js', web), '// Generated from src/core/scroll-settle.ts and image-retry.ts.\n(()=>{\n' + compiled + '\nwindow.ReaderCore = { onSettledScroll, ImageRetryRegistry };\n})();\n');
const cssFile = new URL('style.css', web);
const css = fs.readFileSync(cssFile, 'utf8');
const marker = '/* Native-only mechanics.';
fs.writeFileSync(cssFile, fs.readFileSync(new URL('src/style.css', root), 'utf8') + '\n' + css.slice(css.indexOf(marker)));
