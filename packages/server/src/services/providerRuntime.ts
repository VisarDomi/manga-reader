import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { MangaProvider } from '@manga-reader/provider-types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const providerPromises = new Map<string, Promise<MangaProvider>>();

export async function getServerProvider(providerId = 'comix'): Promise<MangaProvider> {
  const id = providerId || 'comix';
  let promise = providerPromises.get(id);
  if (!promise) {
    promise = import(pathToFileURL(path.join(__dirname, '..', '..', '..', 'extensions', 'dist', 'bundles', `${id}.js`)).href)
      .then((mod: { default: MangaProvider }) => mod.default);
    providerPromises.set(id, promise);
  }
  return promise;
}
