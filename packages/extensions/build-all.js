import { execSync } from 'node:child_process';
import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROVIDERS_DIR = join(__dirname, 'providers');
const DIST_DIR = join(__dirname, 'dist');
const APP_BUNDLED_DIR = join(__dirname, '..', 'app', 'src', 'lib', 'services', 'bundled');

const index = [];

for (const name of readdirSync(PROVIDERS_DIR)) {
  const providerDir = join(PROVIDERS_DIR, name);
  const pkgPath = join(providerDir, 'package.json');
  if (!existsSync(pkgPath)) continue;

  console.log(`Building provider: ${name}`);
  execSync('npm run build', { cwd: providerDir, stdio: 'inherit' });

  // Read metadata from the built bundle
  const bundlePath = join(DIST_DIR, 'bundles', `${name}.js`);
  if (!existsSync(bundlePath)) {
    console.error(`  Bundle not found: ${bundlePath}`);
    continue;
  }

  // Extract metadata by importing the bundle
  const mod = await import(bundlePath);
  const provider = mod.default;
  index.push({
    id: provider.id,
    name: provider.name,
    version: provider.version,
    language: provider.language,
    nsfw: provider.nsfw,
    bundle: `bundles/${name}.js`,
  });

  // Copy bundle to app's bundled fallback directory
  const appBundleDest = join(APP_BUNDLED_DIR, `${name}.js`);
  copyFileSync(bundlePath, appBundleDest);
  console.log(`  Copied to app bundled fallback: ${appBundleDest}`);

  console.log(`  Done: ${provider.id} v${provider.version}`);
}

mkdirSync(DIST_DIR, { recursive: true });
writeFileSync(join(DIST_DIR, 'index.json'), JSON.stringify(index, null, 2) + '\n');
console.log(`\nWrote index.json with ${index.length} provider(s)`);
