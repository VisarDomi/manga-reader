import { comixServerProvider } from './comix.js';
import { mangadotnetServerProvider } from './mangadotnet.js';
import type { ServerMangaProvider } from './types.js';

const providers = new Map<string, ServerMangaProvider>([
  [comixServerProvider.id, comixServerProvider],
  [mangadotnetServerProvider.id, mangadotnetServerProvider],
]);

export function listServerProviders(): ServerMangaProvider[] {
  return [...providers.values()];
}

export function getServerMangaProvider(providerId: string): ServerMangaProvider | null {
  return providers.get(providerId) ?? null;
}

export function requireServerMangaProvider(providerId: string): ServerMangaProvider {
  const provider = getServerMangaProvider(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  return provider;
}
