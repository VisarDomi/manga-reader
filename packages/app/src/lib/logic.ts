export const View = {
  LIST: 'list',
  REPOS: 'repos',
  FAVORITES: 'favorites',
  PROVIDERS: 'providers',
  MANGA: 'manga',
  READER: 'reader',
  CHAPTER_COMMENTS: 'chapter-comments',
} as const;

export const Filter = {
  EMPTY: 'empty',
  INCLUDE: 'include',
  EXCLUDE: 'exclude',
} as const;

export const ErrorKind = {
  UPSTREAM: 'upstream',
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  CLOUDFLARE: 'cloudflare',
  PARSE: 'parse',
} as const;
export type ViewName = typeof View[keyof typeof View];
export type ViewStack = ViewName[];
export type FilterState = typeof Filter[keyof typeof Filter];

export type AppError =
  | { kind: 'upstream'; status: number }
  | { kind: 'timeout' }
  | { kind: 'network' }
  | { kind: 'cloudflare' }
  | { kind: 'parse' };
export const READER_ROOT_MARGIN = '1500%';
