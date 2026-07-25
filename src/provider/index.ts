export { Handler } from './types';
export type { Provider, RouteMatch, ChapterData, ChapterImage, ChapterMeta } from './types';

import type { ChapterMeta, Provider, ChapterData } from './types';
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

let p: Provider;

export const matchRoute = () => {
    const { pathname, hostname } = window.location;
    const entry = Object.entries(SITE_CONFIG).find(([, cfg]) =>
        hostname.includes(cfg.domain),
    );
    if (!entry) throw Error('Unable to select provider');
    p = providers[entry[1].provider as ProviderKey];
    return p.matchRoute(pathname);
};

export const fetchChapter = async (slug: string, chapterId: string) => p.fetchChapter(slug, chapterId);
export const trackChapter = async (data: ChapterData, image?: string, chapterList?: ChapterMeta[]) => p.trackChapter?.(data, image, chapterList)
export const fetchChapterList = async (slug: string) => p.fetchChapterList(slug);
export const readerUrl = (slug: string, chapterId: string, imgIdx?: string) => p.readerUrl(slug, chapterId, imgIdx);
export const seriesUrl = (slug: string) => p.seriesUrl(slug);
export const getNextChapter = (chapterList: ChapterMeta[], lastChapter: string) => p.getNextChapter(chapterList, lastChapter);
