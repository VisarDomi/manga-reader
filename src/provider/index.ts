export { Handler } from './types';
export type { Provider, RouteMatch, ChapterData, ChapterImage, MangaComment } from './types';

import type { Provider, ChapterData } from './types';
import { provider as ezmanga } from './ezmanga/provider';
import { provider as qiscans } from './qiscans/provider';
import { provider as yaksha } from './yaksha/provider';

export const providers = { ezmanga, qiscans, yaksha } as const;

let p: Provider;

export function selectProvider(hostname: string): void {
    if (hostname.includes('ezmanga.org')) p = providers.ezmanga;
    else if (hostname.includes('qimanga.com')) p = providers.qiscans;
    else if (hostname.includes('yakshacomics.com')) p = providers.yaksha;
    else throw Error('Unable to select provider');
}

export const providerName = () => p.name;

// ── lazy forwarders ──────────────────────────────────────────────────

export const matchRoute = (pathname: string, search: string, hash: string) => p.matchRoute(pathname, search, hash);
export const fetchChapter = (slug: string, chapter: number) => p.fetchChapter(slug, chapter);
export const fetchComments = (data: ChapterData) => p.fetchComments(data);
export const seriesUrl = (slug: string) => p.seriesUrl(slug);
