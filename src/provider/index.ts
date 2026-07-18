export { Handler } from './types';
export type { Provider, RouteMatch, ChapterData, ChapterImage, ChapterMeta } from './types';

import type { ChapterMeta, Provider } from './types';
import { Site, SITE_CONFIG } from '../sites';
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

const siteToProviderKey: Record<Site, keyof typeof providers> = {
  [Site.EZManga]: 'ezmanga',
  [Site.QIManga]: 'qiscans',
  [Site.YakshaComics]: 'yaksha',
  [Site.AsuraScans]: 'asura',
  [Site.ScytheScans]: 'scythe',
  [Site.LuaComic]: 'lua',
  [Site.VioletScans]: 'violet',
  [Site.ValirScans]: 'valir',
  [Site.DaveMangaScans]: 'davecubari',
  [Site.Cubari]: 'davecubari',
};

let p: Provider;

export const matchRoute = () => {
    const { pathname, hostname } = window.location;
    const site = (Object.keys(SITE_CONFIG) as Site[]).find(s =>
        hostname.includes(SITE_CONFIG[s].domain),
    );
    if (!site) throw Error('Unable to select provider');
    p = providers[siteToProviderKey[site]];
    return p.matchRoute(pathname);
};

export const fetchChapter = async (slug: string, chapterId: string) => p.fetchChapter(slug, chapterId);
export const fetchChapterList = async (slug: string) => p.fetchChapterList(slug);
export const readerUrl = (slug: string, chapterId: string, imgIdx?: string) => p.readerUrl(slug, chapterId, imgIdx);
export const seriesUrl = (slug: string) => p.seriesUrl(slug);
export const getNextChapter = (chapterList: ChapterMeta[], lastChapter: string) => p.getNextChapter(chapterList, lastChapter);
