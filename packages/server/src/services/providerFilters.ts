import type { FilterDefinition, FilterOption } from '@manga-reader/provider-types';

const COMIX_BROWSE_URL = 'https://comix.to/browse';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const NSFW_NAMES = new Set(['Adult', 'Ecchi', 'Hentai', 'Mature', 'Smut']);

interface CacheEntry {
    filters: FilterDefinition;
    fetchedAt: number;
}

let cache: CacheEntry | null = null;
let inflight: Promise<FilterDefinition> | null = null;

function asOption(item: unknown, group?: string): FilterOption | null {
    if (!item || typeof item !== 'object') return null;
    const raw = item as Record<string, unknown>;
    const id = raw.id == null ? '' : String(raw.id);
    const name = typeof raw.label === 'string' ? raw.label : typeof raw.name === 'string' ? raw.name : '';
    if (!id || !name) return null;
    return {
        id,
        name,
        ...(group ? { group } : {}),
        ...(NSFW_NAMES.has(name) ? { nsfw: true as const } : {}),
    };
}

function optionList(value: unknown, group?: string): FilterOption[] {
    if (!Array.isArray(value)) return [];
    return value.map(item => asOption(item, group)).filter((item): item is FilterOption => item != null);
}

function extractInitialData(html: string): Record<string, unknown> {
    const match = /<script[^>]+id=["']initial-data["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
    if (!match?.[1]) throw new Error('initial-data script missing');
    return JSON.parse(match[1]) as Record<string, unknown>;
}

function parseFilters(html: string): FilterDefinition {
    const initial = extractInitialData(html);
    const list = initial.list && typeof initial.list === 'object' ? initial.list as Record<string, unknown> : {};
    const options = list.options && typeof list.options === 'object' ? list.options as Record<string, unknown> : {};
    const genres = [
        ...optionList(options.genres, 'genre'),
        ...optionList(options.formats, 'format'),
    ];
    const demographics = optionList(options.demographics, 'demographic');
    const types = optionList(options.types);
    const statuses = optionList(options.statuses);

    if (genres.length === 0 || types.length === 0 || statuses.length === 0) {
        throw new Error(`incomplete filter catalog genres=${genres.length} types=${types.length} statuses=${statuses.length}`);
    }

    return {
        genres,
        ...(demographics.length > 0 ? { demographics } : {}),
        ...(types.length > 0 ? { types } : {}),
        ...(statuses.length > 0 ? { statuses } : {}),
    };
}

async function fetchComixFilters(): Promise<FilterDefinition> {
    const started = Date.now();
    const response = await fetch(COMIX_BROWSE_URL, {
        headers: {
            Accept: 'text/html',
            'User-Agent': 'Mozilla/5.0 manga-reader filter-catalog',
        },
    });
    if (!response.ok) throw new Error(`browse http=${response.status}`);
    const html = await response.text();
    const filters = parseFilters(html);
    console.log(`[providerFilters] comix refresh ok genres=${filters.genres.length} demographics=${filters.demographics?.length ?? 0} types=${filters.types?.length ?? 0} statuses=${filters.statuses?.length ?? 0} ${Date.now() - started}ms`);
    return filters;
}

export async function getComixFilters(): Promise<{ filters: FilterDefinition; source: 'cache' | 'upstream'; ageMs: number }> {
    const now = Date.now();
    if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
        return { filters: cache.filters, source: 'cache', ageMs: now - cache.fetchedAt };
    }

    if (!inflight) {
        inflight = fetchComixFilters()
            .then(filters => {
                cache = { filters, fetchedAt: Date.now() };
                return filters;
            })
            .finally(() => {
                inflight = null;
            });
    }

    try {
        const filters = await inflight;
        return { filters, source: 'upstream', ageMs: 0 };
    } catch (error) {
        if (cache) {
            console.log(`[providerFilters] comix refresh failed using stale cache ageMs=${now - cache.fetchedAt} error=${String((error as Error)?.message ?? error)}`);
            return { filters: cache.filters, source: 'cache', ageMs: now - cache.fetchedAt };
        }
        throw error;
    }
}
