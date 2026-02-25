import type { MangaProvider } from '@manga-reader/provider-types';

let activeProvider: MangaProvider | null = null;

interface ProviderMeta {
    id: string;
    name: string;
    version: string;
    language: string;
    nsfw: boolean;
    bundle: string;
}

export async function initProvider(providerId = 'comix'): Promise<void> {
    // Try dynamic loading first
    try {
        const res = await fetch('/providers/index.json');
        if (res.ok) {
            const manifest = await res.json() as ProviderMeta[];
            const meta = manifest.find(p => p.id === providerId);
            if (meta) {
                const mod = await import(/* @vite-ignore */ `/providers/${meta.bundle}`);
                activeProvider = mod.default as MangaProvider;
                console.log(`[provider] Loaded ${meta.name} v${meta.version} (dynamic)`);
                return;
            }
        }
    } catch {
        // Fall through to bundled
    }

    // Fallback: bundled provider
    const mod = await import('./bundled/comix.js');
    activeProvider = mod.default as MangaProvider;
    console.log('[provider] Loaded comix (bundled fallback)');
}

export function getProvider(): MangaProvider {
    if (!activeProvider) throw new Error('Provider not initialized — call initProvider() first');
    return activeProvider;
}
