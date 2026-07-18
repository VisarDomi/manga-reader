export enum Site {
  EZManga = "ezmanga",
  QIManga = "qimanga",
  YakshaComics = "yakshacomics",
  AsuraScans = "asurascans",
  ScytheScans = "scythescans",
  LuaComic = "luacomic",
  VioletScans = "violetscans",
  ValirScans = "valirscans",
  DaveMangaScans = "davemangascans",
  Cubari = "cubari",
}

export interface SiteConfig {
  domain: string;
  apiBase?: string;
  matchPattern?: string;
}

export const SITE_CONFIG: Record<Site, SiteConfig> = {
  [Site.EZManga]: {
    domain: "ezmanga.org",
    apiBase: "https://vapi.ezmanga.org/api/v1",
  },
  [Site.QIManga]: {
    domain: "qimanga.com",
    apiBase: "https://api.qimanga.com/api/v1",
  },
  [Site.YakshaComics]: {
    domain: "yakshacomics.com",
  },
  [Site.AsuraScans]: {
    domain: "asurascans.com",
    apiBase: "https://api.asurascans.com/api",
  },
  [Site.ScytheScans]: {
    domain: "scythescans.com",
  },
  [Site.LuaComic]: {
    domain: "luacomic.org",
  },
  [Site.VioletScans]: {
    domain: "violetscans.org",
  },
  [Site.ValirScans]: {
    domain: "valirscans.org",
  },
  [Site.DaveMangaScans]: {
    domain: "davemangascans.xyz",
  },
  [Site.Cubari]: {
    domain: "cubari.moe",
    matchPattern: "https://cubari.moe/read/gist/*",
  },
};

/** Returns the userscript @match pattern for a site. */
export function userscriptMatch(site: Site): string {
  const cfg = SITE_CONFIG[site];
  return cfg.matchPattern ?? `https://${cfg.domain}/*`;
}
