#!/usr/bin/env node
// Same provider names/registry as scripts/build.mjs, exactly one app per build.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
export function providerRegistry(sites) {
    return Object.fromEntries(Object.entries(sites).filter(([, site]) => site.ios).map(([key, site]) => [site.provider, {
        ...site.ios, key, origin: `https://${site.domain}/`,
    }]));
}
export function selectProvider(args, sites) {
    const names = args.filter(arg => arg !== '--prepare-only');
    if (names.length !== 1 || args.filter(arg => arg === '--prepare-only').length > 1)
        throw new Error('Usage: npm run build:ios -- <provider> [--prepare-only] (exactly one provider is required)');
    const name = names[0];
    const known = Object.values(sites).some(site => site.provider === name);
    if (!known) throw new Error(`Unknown provider: ${name}`);
    const registry = providerRegistry(sites);
    if (!registry[name]) throw new Error(`iOS adapter not implemented for ${name}. Available: ${Object.keys(registry).join(', ')}`);
    return name;
}
export function prepare(provider, sites) {
    const registry = providerRegistry(sites);
    mkdirSync(resolve(root, 'apps/ios/build'), { recursive: true });
    writeFileSync(resolve(root, 'apps/ios/build/providers.json'), JSON.stringify(registry, null, 2) + '\n');
    execFileSync('node', [resolve(root, 'apps/ios/scripts/prepare-web.mjs')], { stdio: 'inherit' });
    console.log(`iOS provider: ${provider} → ${registry[provider].productName} (${registry[provider].bundleIdentifier})`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const args = process.argv.slice(2);
        const sites = JSON.parse(readFileSync(resolve(root, 'src/core/sites.json'), 'utf8'));
        const provider = selectProvider(args, sites);
        if (args.includes('--prepare-only')) prepare(provider, sites);
        else {
            const deploy = resolve(root, 'apps/ios/scripts/deploy.py');
            execFileSync('python3', [deploy, 'sync', provider], { stdio: 'inherit' });
            execFileSync('python3', [deploy, 'guest', provider], { stdio: 'inherit' });
        }
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
