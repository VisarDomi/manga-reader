import config from './sites.json';

export type Site = keyof typeof config;

export interface SiteConfig {
  domain: string;
  apiBase?: string;
  matchPattern?: string;
  provider: string;
}

export const SITE_CONFIG: Record<Site, SiteConfig> = config as Record<Site, SiteConfig>;

/** Returns the userscript @match pattern for a site. */
export function userscriptMatch(site: string): string {
  const cfg = SITE_CONFIG[site as Site];
  return cfg.matchPattern ?? `https://${cfg.domain}/*`;
}
