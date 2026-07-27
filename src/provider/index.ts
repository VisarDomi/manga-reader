export { Handler } from './types';
export type { Provider, RouteMatch, ChapterData, ChapterImage, ChapterMeta } from './types';

import type { Provider, RouteMatch } from './types';
import { SITE_CONFIG } from '../core/sites';
import { ezmanga } from './ezmanga';
import { qiscans } from './qiscans';
import { yaksha } from './yaksha';
import { asura } from './asura';
import { scythe } from './scythe';
import { lua } from './lua';
import { violet } from './violet';
import { valir } from './valir';
import { davecubari } from './davecubari';

const providers = { ezmanga, qiscans, yaksha, asura, scythe, lua, violet, valir, davecubari } as const;
type ProviderKey = keyof typeof providers;

export interface ProviderRoute {
    provider: Provider;
    route: RouteMatch;
}

export function matchProviderRoute(): ProviderRoute | null {
    const { pathname, hostname, hash } = window.location;
    const site = Object.values(SITE_CONFIG).find(cfg =>
        hostname === cfg.domain,
    );
    if (!site) throw new Error('Unable to select provider');

    const provider = providers[site.provider as ProviderKey];
    if (!provider) throw new Error(`Unknown provider: ${site.provider}`);

    const route = provider.matchRoute(pathname, hash);
    if (!route) return null;

    return { provider, route };
}
