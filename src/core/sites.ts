import config from './sites.json';

export type Site = keyof typeof config;

interface SiteConfig {
  domain: string;
  apiBase?: string;
  provider: string;
  documentTitle: string;
}

export const SITE_CONFIG: Record<Site, SiteConfig> = config as Record<Site, SiteConfig>;
