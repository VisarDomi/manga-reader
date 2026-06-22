export { Handler } from './types';
export type { Provider, RouteMatch, ChapterData, ChapterImage, MangaComment } from './types';

import type { Provider } from './types';
import { provider as ezmanga } from './ezmanga/provider';

export const providers = { ezmanga } as const;

let p: Provider;

export function selectProvider(hostname: string): void {
    if (hostname.includes('ezmanga.org')) p = providers.ezmanga;
    else throw Error('Unable to select provider');
}

export const providerName = () => p.name;

// ── lazy forwarders ──────────────────────────────────────────────────

export const matchRoute = (pathname: string, search: string, hash: string) => p.matchRoute(pathname, search, hash);
export const fetchChapter = (slug: string, chapter: number) => p.fetchChapter(slug, chapter);
export const fetchComments = (chapterId: number) => p.fetchComments(chapterId);
export const seriesUrl = (slug: string) => p.seriesUrl(slug);
