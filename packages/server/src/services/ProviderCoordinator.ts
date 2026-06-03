import path from 'node:path';
import { STATE_DIR, BYTE_CACHE_DIR } from '../config.js';
import { CacheDatabase } from '../cache/sqlite.js';
import { ByteCacheService } from '../cache/ByteCacheService.js';
import { CacheService } from '../cache/CacheService.js';
import { BrowserSession } from './BrowserSession.js';
import { CommentsService } from './CommentsService.js';
import { listServerProviders, getServerMangaProvider } from '../providers/registry.js';
import type { ServerMangaProvider } from '../providers/types.js';

export interface ProviderRuntimeOwner {
  provider: ServerMangaProvider;
  db: CacheDatabase;
  browserSession: BrowserSession;
  byteCache: ByteCacheService;
  cache: CacheService;
  comments: CommentsService;
}

export class ProviderCoordinator {
  private readonly owners = new Map<string, ProviderRuntimeOwner>();

  constructor() {
    for (const provider of listServerProviders()) {
      const db = new CacheDatabase(this.dbPath(provider.id));
      const browserSession = new BrowserSession(provider);
      let cache: CacheService | null = null;
      const byteCache = new ByteCacheService(
        this.byteDir(provider.id),
        db,
        provider.id,
        provider.id === 'mangadotnet'
          ? (url, context) => browserSession.fetchRuntimeByte(url, context)
          : undefined,
        () => provider.id !== 'mangadotnet'
          || (browserSession.canRunBackgroundRuntimeWork() && !cache?.hasHigherPriorityDataWork()),
      );
      cache = new CacheService(browserSession, provider, byteCache, db);
      const comments = new CommentsService(cache, provider, browserSession);
      this.owners.set(provider.id, { provider, db, browserSession, byteCache, cache, comments });
    }
  }

  list(): Array<{ id: string; name: string; domain: string; baseUrl: string; ready: boolean; needsHumanClearance: boolean }> {
    return [...this.owners.values()].map(owner => ({
      id: owner.provider.id,
      name: owner.provider.name,
      domain: owner.provider.domain,
      baseUrl: owner.provider.baseUrl,
      ready: owner.browserSession.ready,
      needsHumanClearance: owner.provider.id === 'mangadotnet' && !owner.browserSession.ready,
    }));
  }

  get(providerId?: string | null): ProviderRuntimeOwner | null {
    const id = this.normalizeProviderId(providerId);
    return this.owners.get(id) ?? null;
  }

  require(providerId?: string | null): ProviderRuntimeOwner {
    const owner = this.get(providerId);
    if (!owner) throw new Error(`Unknown provider: ${providerId || 'comix'}`);
    return owner;
  }

  async start(): Promise<void> {
    for (const owner of this.owners.values()) {
      owner.browserSession.init()
        .then(() => {
          owner.cache.start();
          owner.byteCache.start();
        })
        .catch(err => {
          console.error(`[providerCoordinator] init failed provider=${owner.provider.id} domain=${owner.provider.domain}: ${err.message}`);
        });
    }
  }

  async destroy(): Promise<void> {
    await Promise.allSettled([...this.owners.values()].map(owner => owner.browserSession.destroy()));
    for (const owner of this.owners.values()) {
      owner.cache.stop();
      owner.byteCache.close();
    }
  }

  private normalizeProviderId(providerId?: string | null): string {
    const id = typeof providerId === 'string' && providerId.length > 0 ? providerId : 'comix';
    return getServerMangaProvider(id)?.id ?? id;
  }

  private dbPath(providerId: string): string {
    return providerId === 'comix'
      ? path.join(STATE_DIR, 'cache.sqlite')
      : path.join(STATE_DIR, `cache-${providerId}.sqlite`);
  }

  private byteDir(providerId: string): string {
    return providerId === 'comix'
      ? BYTE_CACHE_DIR
      : path.join(STATE_DIR, `bytes-${providerId}`);
  }
}
