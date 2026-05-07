import type { FilterDefinition, MangaProvider } from '@manga-reader/provider-types';
import type { LogEmit } from './LogService.js';

let activeProvider: MangaProvider | null = null;

interface ProviderMeta {
    id: string;
    name: string;
    version: string;
    language: string;
    nsfw: boolean;
    bundle: string;
}

export async function initProvider(providerId = 'comix', emit?: LogEmit): Promise<void> {
    try {
        const res = await fetch('/providers/index.json');
        if (res.ok) {
            const manifest = await res.json() as ProviderMeta[];
            const meta = manifest.find(p => p.id === providerId);
            if (meta) {
                const mod = await import(/* @vite-ignore */ `/providers/${meta.bundle}`);
                activeProvider = mod.default as MangaProvider;
                emit?.('provider-loaded', { name: meta.name, version: meta.version, mode: 'dynamic' });
                return;
            }
        }
    } catch {
    }

    const mod = await import('./bundled/comix.js');
    activeProvider = mod.default as MangaProvider;
    emit?.('provider-loaded', { name: 'comix', mode: 'bundled-fallback' });
}

export function getProvider(): MangaProvider {
    if (!activeProvider) throw new Error('Provider not initialized — call initProvider() first');
    return activeProvider;
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
    const res = await fetch(`/api/provider-filter-search/comix/${type}?keyword=${encodeURIComponent(keyword)}`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { result?: { id?: number | string; label?: string; name?: string }[] };
    return (data.result ?? [])
        .map(item => ({ id: String(item.id ?? ''), name: String(item.label ?? item.name ?? '') }))
        .filter(item => item.id.length > 0 && item.name.length > 0);
}
