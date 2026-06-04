import type { FilterDefinition, MangaProvider } from '@manga-reader/provider-types';
import type { LogEmit } from './LogService.js';
import * as storage from './storage.js';

let activeProvider: MangaProvider | null = null;
let activeProviderId = storage.getString('active-provider-id', 'comix');

interface ProviderMeta {
    id: string;
    name: string;
    version: string;
    language: string;
    nsfw: boolean;
    bundle: string;
}

export interface ProviderRuntimeSummary {
    id: string;
    name: string;
    domain: string;
    baseUrl: string;
    enabled: boolean;
    ready: boolean;
    needsHumanClearance: boolean;
}

async function bundledProvider(providerId: string): Promise<MangaProvider> {
    if (providerId === 'mangadotnet') {
        const mod = await import('./bundled/mangadotnet.js');
        return mod.default as MangaProvider;
    }
    const mod = await import('./bundled/comix.js');
    return mod.default as MangaProvider;
}

export async function initProvider(providerId = activeProviderId, emit?: LogEmit): Promise<void> {
    activeProviderId = providerId;
    storage.setString('active-provider-id', providerId);
    try {
        const res = await fetch('/providers/index.json');
        if (res.ok) {
            const manifest = await res.json() as ProviderMeta[];
            const meta = manifest.find(p => p.id === providerId);
            if (meta) {
                const mod = await import(/* @vite-ignore */ `/providers/${meta.bundle}`);
                activeProvider = mod.default as MangaProvider;
                activeProviderId = activeProvider.id;
                storage.setString('active-provider-id', activeProvider.id);
                emit?.('provider-loaded', { name: meta.name, version: meta.version, mode: 'dynamic' });
                return;
            }
        }
    } catch (e) {
        emit?.('provider-dynamic-load-failed', {
            providerId,
            error: String((e as Error)?.message ?? e),
        });
    }

    activeProvider = await bundledProvider(providerId);
    activeProviderId = activeProvider.id;
    storage.setString('active-provider-id', activeProvider.id);
    emit?.('provider-loaded', { name: activeProvider.name, mode: 'bundled-fallback' });
}

export function getProvider(): MangaProvider {
    if (!activeProvider) throw new Error('Provider not initialized — call initProvider() first');
    return activeProvider;
}

export function getProviderId(): string {
    return activeProvider?.id ?? activeProviderId;
}

export async function switchProvider(providerId: string, emit?: LogEmit): Promise<MangaProvider> {
    if (providerId === getProviderId() && activeProvider) return activeProvider;
    await initProvider(providerId, emit);
    return getProvider();
}

export async function fetchProviderRuntimeSummaries(): Promise<ProviderRuntimeSummary[]> {
    const res = await fetch('/api/providers');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { result?: ProviderRuntimeSummary[] };
    return data.result ?? [];
}

export async function setProviderRuntimeEnabled(providerId: string, enabled: boolean): Promise<ProviderRuntimeSummary[]> {
    const res = await fetch(`/api/providers/${encodeURIComponent(providerId)}/enabled`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { result?: ProviderRuntimeSummary[] };
    return data.result ?? [];
}

export async function refreshProviderFilters(providerId = 'comix', emit?: LogEmit): Promise<FilterDefinition> {
    const provider = getProvider();
    try {
        const res = await fetch(`/api/provider-filters/${encodeURIComponent(providerId)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { result?: FilterDefinition; meta?: { source?: string; ageMs?: number } };
        if (!data.result || !Array.isArray(data.result.genres)) throw new Error('Invalid filter payload');
        provider.setFilters?.(data.result);
        emit?.('provider-filters-loaded', {
            source: data.meta?.source ?? 'unknown',
            ageMs: Number(data.meta?.ageMs ?? 0),
            genres: data.result.genres.length,
            demographics: data.result.demographics?.length ?? 0,
            types: data.result.types?.length ?? 0,
            statuses: data.result.statuses?.length ?? 0,
        });
    } catch (e) {
        const fallback = provider.getFilters();
        emit?.('provider-filters-fallback', {
            error: String((e as Error)?.message ?? e),
            genres: fallback.genres.length,
            demographics: fallback.demographics?.length ?? 0,
            types: fallback.types?.length ?? 0,
            statuses: fallback.statuses?.length ?? 0,
        });
    }
    return provider.getFilters();
}

export interface ProviderFilterSearchOption {
    id: string;
    name: string;
}

export async function searchProviderFilters(type: 'tag' | 'author' | 'artist', keyword: string, signal?: AbortSignal): Promise<ProviderFilterSearchOption[]> {
    const res = await fetch(`/api/provider-filter-search/${encodeURIComponent(getProviderId())}/${type}?keyword=${encodeURIComponent(keyword)}`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { result?: { id?: number | string; label?: string; name?: string }[] };
    return (data.result ?? [])
        .map(item => ({ id: String(item.id ?? ''), name: String(item.label ?? item.name ?? '') }))
        .filter(item => item.id.length > 0 && item.name.length > 0);
}
