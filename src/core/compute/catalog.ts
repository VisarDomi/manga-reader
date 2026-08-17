// Worker-side catalog router for the JSON-API providers. HTML-scraping
// providers (yaksha, scythe, violet) intentionally stay on the main thread.
import type { HomePage } from '../../provider/types';
import type { Site } from '../../core/sites';
import { fetchAsuraHome } from '../../provider/asura-catalog';
import { fetchValirHome } from '../../provider/valir-catalog';
import { fetchAngularHome } from '../../provider/angular-catalog';
import { fetchLuaHome } from '../../provider/lua-catalog';
import { workerContext } from './context';

const WORKER_CATALOGS: Record<string, (cursor: string | null, referrer?: string) => Promise<HomePage>> = {
    asurascans: fetchAsuraHome,
    valirscans: fetchValirHome,
    ezmanga: (cursor, referrer) => fetchAngularHome('ezmanga' as Site, cursor, referrer),
    qimanga: (cursor, referrer) => fetchAngularHome('qimanga' as Site, cursor, referrer),
    luacomic: fetchLuaHome,
};

export function fetchCatalogHome(providerKey: string, cursor: string | null): Promise<HomePage> {
    const fetchHome = WORKER_CATALOGS[providerKey];
    if (!fetchHome) throw new Error(`Provider ${providerKey} has no worker catalog`);
    // Some Cloudflare-fronted provider APIs reject requests whose Referer is
    // not the site page: a worker's default referrer is not the page URL.
    return fetchHome(cursor, workerContext().href);
}
