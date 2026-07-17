export { Handler } from './types';
export type { Provider, RouteMatch, ChapterData, ChapterImage, ChapterMeta } from './types';

import type { Provider } from './types';
import { ezmanga as ezmanga } from './ezmanga';
import { qiscans as qiscans } from './qiscans';
import { yaksha as yaksha } from './yaksha';

const providers = { ezmanga, qiscans, yaksha } as const;

let p: Provider;

export const matchRoute = () => {
    const { pathname, hostname } = window.location;
    if (hostname.includes('ezmanga.org')) p = providers.ezmanga;
    else if (hostname.includes('qimanga.com')) p = providers.qiscans;
    else if (hostname.includes('yakshacomics.com')) p = providers.yaksha;
    else throw Error('Unable to select provider');
    return p.matchRoute(pathname);
}
export const fetchChapter = (slug: string, chapterId: string) => p.fetchChapter(slug, chapterId);
export const fetchChapterList = (slug: string) => p.fetchChapterList(slug);
export const readerUrl = (slug: string, chapterId: string, imgIdx?: string) => p.readerUrl(slug, chapterId, imgIdx);
export const seriesUrl = (slug: string) => p.seriesUrl(slug);
