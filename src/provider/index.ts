export { Handler } from './types';
export type { GalleryMeta, Provider, RouteMatch, SearchPage, GalleryFile } from './types';

import type { GalleryFile, Provider } from './types';
import { provider as hitomi } from './hitomi/provider';
import { provider as imhentai } from './imhentai/provider';

export const providers = { hitomi, imhentai } as const;

let p: Provider;

export function selectProvider(hostname: string): void {
    if (hostname.includes('hitomi.la')) p = providers.hitomi;
    else if (hostname.includes('imhentai.xxx')) p = providers.imhentai;
    else throw Error('Unable to select provider');
}

export const providerName = () => p.name;

// ── lazy forwarders ──────────────────────────────────────────────────

export const fetchMeta = (gid: number) => p.fetchMeta(gid);
export const thumbUrl = (file: GalleryFile) => p.thumbUrl(file);
export const imageUrls = (files: GalleryFile[]) => p.imageUrls(files);
export const search = (rawQuery: string, page: number) => p.search(rawQuery, page);
export const readerUrl = (gid: number, index?: number) => p.readerUrl(gid, index);
export const goToPage = (query: string, page: number) => p.goToPage(query, page);
export const searchUrl = (query: string, page?: number) => p.searchUrl(query, page);
export const tagSearchUrl = (ns: string, value: string, language: string) => p.tagSearchUrl(ns, value, language);
export const initProvider = () => p.init();
export const matchRoute = (pathname: string, search: string, hash: string) => p.matchRoute(pathname, search, hash);
