export {
    ChapterLoadIntent,
    ChapterLoadResultKind,
    Handler,
    HomeDestinationKind,
} from './types';
export type {
    Provider,
    RouteMatch,
    ChapterData,
    ChapterImage,
    ChapterMeta,
    ChapterAppendRequest,
    ChapterAppendResult,
    ChapterLoader,
    ChapterLoadRequest,
    ChapterOpenRequest,
    ChapterOpenResult,
    HomeDestinationRequest,
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
import { yaksha } from './yaksha';
import { createEzmangaProvider } from './ezmanga';
import { createQiscansProvider } from './qiscans';

// Keyed by PROVIDER name (site.provider), not by site key.
type ProviderMap = Record<string, Provider>;

interface InitializedProviderRoute {
    provider: Provider;
    route: RouteMatch;
    documentTitle: string;
}

export function initializeProviderRoute(url: URL): InitializedProviderRoute | null {
    const { pathname, hostname, hash } = url;
    const site = Object.values(SITE_CONFIG).find(cfg =>
        hostname === cfg.domain,
    );
    if (!site) return null;

    const providers: ProviderMap = {
        ezmanga: createEzmangaProvider(),
        qiscans: createQiscansProvider(),
        yaksha,
        asura,
        scythe,
        lua,
    };
    const provider = providers[site.provider];
    if (!provider) throw new Error('Unknown provider: ' + site.provider);

    const route = provider.matchRoute(pathname, hash);
    if (!route) return null;
    return { provider, route, documentTitle: site.documentTitle };
}
