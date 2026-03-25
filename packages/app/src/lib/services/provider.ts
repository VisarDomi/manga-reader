import type { MangaProvider } from '@manga-reader/provider-types';
import type { LogFn } from './LogService.js';

let activeProvider: MangaProvider | null = null;

interface ProviderMeta {
    id: string;
    name: string;
    version: string;
    language: string;
    nsfw: boolean;
    bundle: string;
}

export async function initProvider(providerId = 'comix', log?: LogFn): Promise<void> {
    try {
        const res = await fetch('/providers/index.json');
        if (res.ok) {
            const manifest = await res.json() as ProviderMeta[];
            const meta = manifest.find(p => p.id === providerId);
            if (meta) {
                const mod = await import(/* @vite-ignore */ `/providers/${meta.bundle}`);
                activeProvider = mod.default as MangaProvider;
                log?.('provider-loaded', { name: meta.name, version: meta.version, mode: 'dynamic' });
                return;
            }
        }
    } catch {
    }

    const mod = await import('./bundled/comix.js');
    activeProvider = mod.default as MangaProvider;
    log?.('provider-loaded', { name: 'comix', mode: 'bundled-fallback' });
}

export function getProvider(): MangaProvider {
    if (!activeProvider) throw new Error('Provider not initialized — call initProvider() first');
    return activeProvider;
}
