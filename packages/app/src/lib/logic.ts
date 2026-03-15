// Pure constants and types extracted from business rules.
// These have no dependencies on DOM, IDB, fetch, or Svelte.
// Functions belong in the app code that implements the behavior.

// --- Const Objects ---

export const View = {
  LIST: 'list',
  REPOS: 'repos',
  FAVORITES: 'favorites',
  MANGA: 'manga',
  READER: 'reader',
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

// --- Types ---

export type ViewName = typeof View[keyof typeof View];
export type ViewStack = ViewName[];
export type FilterState = typeof Filter[keyof typeof Filter];

export type AppError =
  | { kind: 'upstream'; status: number }
  | { kind: 'timeout' }
  | { kind: 'network' }
  | { kind: 'cloudflare' }
  | { kind: 'parse' };

// --- Constants ---

export const READER_ROOT_MARGIN = '1500%';
