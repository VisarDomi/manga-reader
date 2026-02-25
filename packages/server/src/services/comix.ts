import {
  COMIX_API_URL,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_DEFAULT_ORDER,
  SEARCH_DEFAULT_ORDER_FIELD,
  CHAPTERS_DEFAULT_LIMIT,
  CHAPTERS_DEFAULT_ORDER,
  CHAPTERS_DEFAULT_ORDER_FIELD,
} from '../config';
import { proxyFetch } from '../utils/proxyFetch';

export async function fetchSearch(query: Record<string, string | string[]>): Promise<unknown> {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      // Express qs strips [] from keys — add it back for comix.to API
      const arrayKey = key.endsWith('[]') ? key : `${key}[]`;
      for (const v of value) params.append(arrayKey, String(v));
    } else if (value != null) {
      params.set(key, String(value));
    }
  }

  if (!params.has('limit')) params.set('limit', String(SEARCH_DEFAULT_LIMIT));
  if (!params.has(`order[${SEARCH_DEFAULT_ORDER_FIELD}]`)) {
    params.set(`order[${SEARCH_DEFAULT_ORDER_FIELD}]`, SEARCH_DEFAULT_ORDER);
  }

  const r = await proxyFetch(`${COMIX_API_URL}/manga?${params}`);
  return r.json();
}

export async function fetchChapters(
  slug: string,
  limit: number = CHAPTERS_DEFAULT_LIMIT,
  page: number = 1,
): Promise<unknown> {
  const url = new URL(`${COMIX_API_URL}/manga/${slug}/chapters`);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('page', String(page));
  url.searchParams.set(`order[${CHAPTERS_DEFAULT_ORDER_FIELD}]`, CHAPTERS_DEFAULT_ORDER);

  const r = await proxyFetch(url.toString());
  return r.json();
}

export async function postHistory(
  body: unknown,
  headers: Record<string, string>,
): Promise<unknown> {
  const r = await proxyFetch(`${COMIX_API_URL}/account/history`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return r.json();
}

export async function fetchHistory(
  mangaId: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const r = await proxyFetch(`${COMIX_API_URL}/account/history/${mangaId}`, { headers });
  return r.json();
}
