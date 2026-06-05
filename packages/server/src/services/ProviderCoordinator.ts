import path from 'node:path';
import fs from 'node:fs';
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

export interface ProviderSummary {
  id: string;
  name: string;
  domain: string;
  baseUrl: string;
  enabled: boolean;
  ready: boolean;
  needsHumanClearance: boolean;
  runtimeState: ProviderRuntimeState;
}

interface ProviderRuntimeSettings {
  enabledProviderIds?: string[];
}

type ProviderRuntimeState = 'disabled' | 'warming' | 'ready' | 'degraded' | 'stopping';

export class ProviderCoordinator {
  private readonly owners = new Map<string, ProviderRuntimeOwner>();
  private readonly enabledProviderIds: Set<string>;
  private readonly runtimeStates = new Map<string, ProviderRuntimeState>();
  private readonly settingsPath = path.join(STATE_DIR, 'provider-runtime.json');

  constructor() {
    this.enabledProviderIds = new Set(this.loadEnabledProviderIds());
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
      this.runtimeStates.set(provider.id, this.isEnabled(provider.id) ? 'warming' : 'disabled');
    }
  }

  list(): ProviderSummary[] {
    return [...this.owners.values()].map(owner => ({
      id: owner.provider.id,
      name: owner.provider.name,
      domain: owner.provider.domain,
      baseUrl: owner.provider.baseUrl,
      enabled: this.isEnabled(owner.provider.id),
      ready: this.isEnabled(owner.provider.id) && owner.browserSession.canServeRuntimeRequests(),
      needsHumanClearance: this.isEnabled(owner.provider.id) && !owner.browserSession.canServeRuntimeRequests(),
      runtimeState: this.runtimeStates.get(owner.provider.id) ?? (this.isEnabled(owner.provider.id) ? 'warming' : 'disabled'),
    }));
  }

  get(providerId?: string | null): ProviderRuntimeOwner | null {
    const id = this.normalizeProviderId(providerId);
    if (!this.isEnabled(id)) return null;
    return this.owners.get(id) ?? null;
  }

  require(providerId?: string | null): ProviderRuntimeOwner {
    const owner = this.get(providerId);
    if (!owner) throw new Error(`Unknown provider: ${providerId || 'comix'}`);
    return owner;
  }

  async start(): Promise<void> {
    for (const owner of this.owners.values()) {
      if (!this.isEnabled(owner.provider.id)) {
        this.setRuntimeState(owner.provider.id, 'disabled', 'startup-disabled');
        console.log(`[providerCoordinator] provider-disabled provider=${owner.provider.id} action=skip-start`);
        owner.cache.recoverExpiredDurableLeases('provider-disabled-startup');
        owner.cache.suspend();
        owner.byteCache.suspend();
        continue;
      }
      void this.startOwner(owner, 'startup');
    }
  }

  async destroy(): Promise<void> {
    await Promise.allSettled([...this.owners.values()].map(owner => owner.browserSession.destroy()));
    for (const owner of this.owners.values()) {
      owner.cache.stop();
      owner.byteCache.close();
    }
  }

  async setEnabled(providerId: string, enabled: boolean): Promise<ProviderSummary[]> {
    const id = this.normalizeProviderId(providerId);
    const owner = this.owners.get(id);
    if (!owner) throw new Error(`Unknown provider: ${providerId}`);
    if (enabled) {
      this.enabledProviderIds.add(id);
      this.saveEnabledProviderIds();
      this.setRuntimeState(id, 'warming', 'enabled');
      void this.startOwner(owner, 'enabled');
      return this.list();
    }

    if (this.enabledProviderIds.size <= 1 && this.enabledProviderIds.has(id)) {
      throw new Error('At least one provider must remain enabled');
    }
    this.enabledProviderIds.delete(id);
    this.saveEnabledProviderIds();
    this.setRuntimeState(id, 'stopping', 'disabled');
    owner.cache.recoverExpiredDurableLeases('provider-disabled');
    owner.cache.suspend();
    owner.byteCache.suspend();
    await owner.browserSession.destroy();
    this.setRuntimeState(id, 'disabled', 'stopped');
    console.log(`[providerCoordinator] provider-disabled provider=${id} action=stopped`);
    return this.list();
  }

  isEnabled(providerId: string): boolean {
    return this.enabledProviderIds.has(this.normalizeProviderId(providerId));
  }

  private startOwner(owner: ProviderRuntimeOwner, reason: string): Promise<void> {
    const providerId = owner.provider.id;
    this.setRuntimeState(providerId, 'warming', reason);
    return owner.browserSession.init()
      .then(() => {
        if (!this.isEnabled(providerId)) return;
        return owner.browserSession.warmRuntimeHttp(reason);
      })
      .then(() => {
        if (!this.isEnabled(providerId)) return;
        owner.cache.start();
        owner.byteCache.start();
        this.setRuntimeState(providerId, 'ready', reason);
      })
      .catch(err => {
        if (this.isEnabled(providerId)) this.setRuntimeState(providerId, 'degraded', reason, err.message);
        console.error(`[providerCoordinator] init failed provider=${owner.provider.id} domain=${owner.provider.domain} reason=${reason}: ${err.message}`);
      });
  }

  private setRuntimeState(providerId: string, state: ProviderRuntimeState, reason: string, error?: string): void {
    const previous = this.runtimeStates.get(providerId);
    if (previous === state) return;
    this.runtimeStates.set(providerId, state);
    const suffix = error ? ` error=${singleLine(error)}` : '';
    console.log(`[providerCoordinator] runtime-state provider=${providerId} from=${previous ?? 'unknown'} to=${state} reason=${reason}${suffix}`);
  }

  private loadEnabledProviderIds(): string[] {
    const providers = listServerProviders().map(provider => provider.id);
    try {
      const raw = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8')) as ProviderRuntimeSettings;
      const enabled = (raw.enabledProviderIds ?? []).filter(id => providers.includes(id));
      return enabled.length > 0 ? [...new Set(enabled)] : providers;
    } catch {
      return providers;
    }
  }

  private saveEnabledProviderIds(): void {
    fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
    const enabledProviderIds = [...this.enabledProviderIds].filter(id => this.owners.has(id));
    fs.writeFileSync(this.settingsPath, JSON.stringify({ enabledProviderIds }, null, 2));
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

function singleLine(value: string): string {
  return value.split('\n')[0]?.trim().slice(0, 300) || 'unknown-error';
}
