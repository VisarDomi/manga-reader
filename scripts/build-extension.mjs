import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

execFileSync('npx', ['vite', 'build', '--mode', 'extension'], { stdio: 'inherit' });
const file = 'dist/extension/content.js';
const source = readFileSync(file, 'utf8');
const revoke = '"(self.URL || self.webkitURL).revokeObjectURL(self.location.href);",';
if (!source.includes(revoke)) throw new Error('Vite inline-worker wrapper changed; inspect before shipping');
writeFileSync(file, source.replaceAll(revoke, '"",'));
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const sites = JSON.parse(readFileSync('src/core/sites.json', 'utf8'));
const matches = Object.values(sites).map(site => `https://${site.domain}/*`);
writeFileSync('dist/extension/manifest.json', JSON.stringify({
    manifest_version: 3,
    name: 'Manga Reader',
    version,
    description: 'Manga Reader document-start takeover for six providers.',
    host_permissions: matches,
    content_scripts: [{
        matches, js: ['content.js'], run_at: 'document_start', world: 'MAIN', all_frames: false,
    }],
}, null, 2) + '\n');
console.log('Private extension built: dist/extension (contains PC backup key; do not publish).');
