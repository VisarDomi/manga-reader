import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { MangaProvider } from '@manga-reader/provider-types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let providerPromise: Promise<MangaProvider> | null = null;

export async function getServerProvider(): Promise<MangaProvider> {
  providerPromise ??= import(pathToFileURL(path.join(__dirname, '..', '..', '..', 'extensions', 'dist', 'bundles', 'comix.js')).href)
    .then((mod: { default: MangaProvider }) => mod.default);
  return providerPromise;
}
