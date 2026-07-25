#!/usr/bin/env node
/**
 * Build script. Single source of truth: src/sites.json
 *
 * Usage:
 *   node scripts/build.mjs                    – all → dist/manga-reader.user.js
 *   node scripts/build.mjs asura              – only asura → dist/asura-reader.user.js
 *   node scripts/build.mjs -asura             – all except → manga-reader.user.js
 *   node scripts/build.mjs asura,qimanga      – only those → manga-reader.user.js
 *   node scripts/build.mjs -asura,qimanga     – all except → manga-reader.user.js
 *
 * Filtered builds:
 *   - Writes a temp _empty.ts stub with null exports for excluded providers
 *   - Vite aliases excluded modules to that stub (via EXCLUDE_PROVIDERS env)
 *   - Also filters @match patterns (MATCH_SITES) and output name (BUILD_NAME)
 *   - Cleans up _empty.ts after build
 */

import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

// ── Version increment ────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgPath = resolve(__dirname, '..', 'package.json');
const pkgJson = JSON.parse(readFileSync(pkgPath, 'utf-8'));
pkgJson.version = (parseInt(pkgJson.version, 10) + 1).toString();
writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2) + '\n', 'utf-8');
console.log(`Version incremented -> ${pkgJson.version}`);

// ── Read registry ────────────────────────────────────────────────────

const registry = JSON.parse(readFileSync('src/core/sites.json', 'utf-8'));

// Group sites by provider module
const providerGroups = {};
for (const [siteKey, cfg] of Object.entries(registry)) {
  const prov = cfg.provider;
  if (!providerGroups[prov]) providerGroups[prov] = { sites: [], module: prov };
  providerGroups[prov].sites.push(siteKey);
}

const ALL_MODULES = Object.keys(providerGroups);

// ── Parse args ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const include = [];
const exclude = [];

for (const arg of args) {
  for (const item of arg.split(',')) {
    (item.startsWith('-') ? exclude : include).push(item.replace(/^-/, ''));
  }
}

let filteredModules;
if (include.length > 0) {
  filteredModules = include;
  const unknown = include.filter(n => !ALL_MODULES.includes(n));
  if (unknown.length) {
    console.error(`[build] Unknown providers: ${unknown.join(', ')}`);
    console.error(`[build] Available: ${ALL_MODULES.join(', ')}`);
    process.exit(1);
  }
} else if (exclude.length > 0) {
  filteredModules = ALL_MODULES.filter(m => !exclude.includes(m));
} else {
  filteredModules = ALL_MODULES;
}

const allProvided = filteredModules.length === ALL_MODULES.length;

// ── Compute env vars ─────────────────────────────────────────────────

const excludedModules = ALL_MODULES.filter(m => !filteredModules.includes(m));
const matchSites = [...new Set(filteredModules.flatMap(m => providerGroups[m].sites))].join(',');
const buildName = include.length === 1 ? `${include[0]}-reader` : '';

// ── Build ────────────────────────────────────────────────────────────

const env = {
  ...process.env,
  EXCLUDE_PROVIDERS: excludedModules.join(','),
  MATCH_SITES: allProvided ? '' : matchSites,
  BUILD_NAME: buildName,
};

// Generate stub for excluded providers (vite.config.ts aliases to this)
const STUB = 'src/provider/_empty.ts';
if (excludedModules.length > 0) {
  const exports = ALL_MODULES.map(n => `export const ${n} = null;`).join('\n');
  writeFileSync(STUB, exports + '\n');
  console.log(`[build] Excluding: ${excludedModules.join(', ')}`);
} else {
  console.log('[build] All providers');
}

try {
  execSync('npx vite build', { stdio: 'inherit', env });
} finally {
  // Clean up temp stub
  try { unlinkSync(STUB); } catch {}
}

console.log('[build] Done');
