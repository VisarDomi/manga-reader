export { Handler } from './types';
export type {
    Provider,
    RouteMatch,
    ChapterData,
    ChapterImage,
    ChapterMeta,
    HomeChapter,
    HomeSeries,
    HomePage,
    RemoteSeriesHistory,
} from './types';

import type { Provider, RouteMatch } from './types';
import { SITE_CONFIG } from '../core/sites';
import { asura } from './asura';
import { scythe } from './scythe';
import { lua } from './lua';
import { violet } from './violet';
import { valir } from './valir';
import { yaksha } from './yaksha';
import { createEzmangaProvider } from './ezmanga';
import { createQiscansProvider } from './qiscans';

// Keyed by PROVIDER name (site.provider), not by site key.
type ProviderMap = Record<string, Provider>;

// Built at runtime, inside a function — importing this module performs no
// construction. The Angular providers (ezmanga/qimanga) are factories so
// nothing executes at module scope.
let providers: ProviderMap | null = null;

function getProviders(): ProviderMap {
    providers ??= {
        ezmanga: createEzmangaProvider(),
        qiscans: createQiscansProvider(),
        yaksha,
        asura,
        scythe,
        lua,
        violet,
        valir,
    };
    return providers;
}

/** Pure lookup by provider name — used by route resolution and tests. */
export function providerForSite(providerName: string): Provider | undefined {
    return getProviders()[providerName];
}

export interface InitializedProviderRoute {
    provider: Provider;
    route: RouteMatch;
    documentTitle: string;
}

export function initializeProviderRoute(): InitializedProviderRoute | null {
    const { pathname, hostname, hash } = window.location;
    const site = Object.values(SITE_CONFIG).find(cfg =>
        hostname === cfg.domain,
    );
    if (!site) throw new Error('Unable to select provider');

    const provider = providerForSite(site.provider);
    if (!provider) throw new Error('Unknown provider: ' + site.provider);

    const route = provider.matchRoute(pathname, hash);
    if (!route) return null;
    const documentTitle = document.title.trim() || provider.documentTitle;

    return { provider, route, documentTitle };
}
