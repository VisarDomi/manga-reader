// Pure logic functions extracted from business rules.
// These functions have no dependencies on DOM, IDB, fetch, or Svelte.

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

interface ChapterEntry {
  id: string;
  number: number;
  groupId?: string;
  groupName: string;
  uploadedAt?: number;
}

interface HasId {
  id: string;
}

// --- Constants ---

export const READER_ROOT_MARGIN = '1500%';

// --- Functions ---

export function cycleGenreFilter(current: FilterState): FilterState {
  if (current === Filter.EMPTY) return Filter.INCLUDE;
  if (current === Filter.INCLUDE) return Filter.EXCLUDE;
  return Filter.EMPTY;
}

export function toggleBinaryFilter(current: boolean): boolean {
  return !current;
}

export function deduplicateByMangaId<T extends HasId>(existing: T[], incoming: T[]): T[] {
  const seen = new Set(existing.map(m => m.id));
  const deduped = incoming.filter(m => !seen.has(m.id));
  return [...existing, ...deduped];
}

export function filteredChapters(
  chapters: ChapterEntry[],
  blacklistedGroupIds: Set<string>,
  selectedGroupIds: Set<string> | null,
): ChapterEntry[] {
  let chs: ChapterEntry[];

  if (selectedGroupIds) {
    chs = chapters.filter(ch => selectedGroupIds.has(ch.groupId ?? ''));
    const best = new Map<number, ChapterEntry>();
    for (const ch of chs) {
      const existing = best.get(ch.number);
      if (!existing || (ch.uploadedAt ?? 0) > (existing.uploadedAt ?? 0))
        best.set(ch.number, ch);
    }
    chs = [...best.values()];
  } else {
    chs = chapters.filter(ch => !blacklistedGroupIds.has(ch.groupId ?? ''));
  }

  return chs.sort((a, b) => b.number - a.number);
}

export const VALID_STACKS: ViewStack[] = [
  [View.LIST],
  [View.LIST, View.REPOS],
  [View.LIST, View.FAVORITES],
  [View.LIST, View.MANGA],
  [View.LIST, View.FAVORITES, View.MANGA],
  [View.LIST, View.MANGA, View.READER],
  [View.LIST, View.FAVORITES, View.MANGA, View.READER],
];

export function isValidStack(stack: ViewStack): boolean {
  return VALID_STACKS.some(
    valid => valid.length === stack.length && valid.every((v, i) => v === stack[i]),
  );
}

export function popViewStack(stack: ViewStack): ViewStack {
  if (stack.length <= 1) return stack;
  return stack.slice(0, -1);
}

export function shouldLoadNextPage(isLoading: boolean, hasMore: boolean, isRestoring: boolean): boolean {
  return !isLoading && hasMore && !isRestoring;
}

export interface ErrorLogEntry {
  url: string;
  kind: string;
  status?: number;
  body?: string;
  timestamp: number;
}

export function formatErrorLog(error: AppError, url: string, body?: string): ErrorLogEntry {
  const entry: ErrorLogEntry = {
    url,
    kind: error.kind,
    timestamp: Date.now(),
  };
  if (error.kind === ErrorKind.UPSTREAM) entry.status = error.status;
  if (body != null) entry.body = body;
  return entry;
}

const TRANSIENT_CODES = new Set([408, 429, 500, 502, 503, 504]);

export function isTransient(error: AppError): boolean {
  if (error.kind === ErrorKind.TIMEOUT || error.kind === ErrorKind.NETWORK) return true;
  if (error.kind === ErrorKind.UPSTREAM && TRANSIENT_CODES.has(error.status)) return true;
  return false;
}
