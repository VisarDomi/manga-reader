export { Handler } from './types';
export type { Provider, RouteMatch, ChapterData, ChapterImage, ChapterMeta } from './types';

import type {ChapterMeta, Provider} from './types';
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

let p: Provider;

export const matchRoute = () => {
    const { pathname, hostname } = window.location;
    if (hostname.includes('ezmanga.org')) p = providers.ezmanga;
    else if (hostname.includes('qimanga.com')) p = providers.qiscans;
    else if (hostname.includes('yakshacomics.com')) p = providers.yaksha;
    else if (hostname.includes('asurascans.com')) p = providers.asura;
    else if (hostname.includes('scythescans.com')) p = providers.scythe;
    else if (hostname.includes('luacomic.org')) p = providers.lua;
    else if (hostname.includes('violetscans.org')) p = providers.violet;
    else if (hostname.includes('valirscans.org')) p = providers.valir;
    else if (hostname.includes('davemangascans.xyz')) p = providers.davecubari;
    else if (hostname.includes('cubari.moe')) p = providers.davecubari;
    else throw Error('Unable to select provider');
    return p.matchRoute(pathname);
}
export const fetchChapter = async (slug: string, chapterId: string) => p.fetchChapter(slug, chapterId);
export const fetchChapterList = async (slug: string) => p.fetchChapterList(slug);
export const readerUrl = (slug: string, chapterId: string, imgIdx?: string) => p.readerUrl(slug, chapterId, imgIdx);
export const seriesUrl = (slug: string) => p.seriesUrl(slug);
export const getNextChapter = (chapterList: ChapterMeta[], lastChapter: string) => p.getNextChapter(chapterList, lastChapter);
