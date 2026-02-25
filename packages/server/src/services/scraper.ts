import { COMIX_BASE_URL } from '../config';
import { proxyFetch } from '../utils/proxyFetch';

export interface ChapterImage {
  url: string;
  width: number;
  height: number;
}

/**
 * Extracts a JSON array value from inline HTML/JS by key name.
 *
 * comix.to embeds chapter data in <script> tags in two possible formats:
 * 1. Escaped: \"images\":[ ... ] — inside JSON strings within JS (e.g. x-data attributes)
 * 2. Unescaped: "images":[ ... ] — inside inline <script> blocks
 * Both patterns are tried because the upstream page format varies between renders.
 */
function extractJsonArray(html: string, key: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const needles: [string, boolean][] = [
    [`\\"${escapedKey}\\"`, true],
    [`"${escapedKey}"`, false],
  ];

  for (const [needle, escaped] of needles) {
    const idx = html.indexOf(needle);
    if (idx === -1) continue;

    const rest = html.slice(idx + needle.length);
    const match = rest.match(/^\s*:\s*(\[[\s\S]*?\])/);
    if (!match) {
      const snippet = rest.slice(0, 200);
      console.error(`[scraper] Key "${key}" found (escaped=${escaped}) but no array followed. Snippet: ${snippet}`);
      continue;
    }

    let raw = match[1];
    if (escaped) {
      raw = raw.replace(/\\"/g, '"').replace(/\\\//g, '/');
    }

    try {
      JSON.parse(raw);
    } catch (err) {
      const snippet = rest.slice(0, 200);
      console.error(`[scraper] JSON parse failed for key "${key}". Error: ${(err as Error).message}. Snippet: ${snippet}`);
      continue;
    }

    return raw;
  }

  throw new Error(`Key "${key}" not found in HTML (tried both escaped and unescaped patterns)`);
}

export async function scrapeChapterImages(
  slug: string,
  chapterId: string,
  chapterNumber: string,
): Promise<ChapterImage[]> {
  const targetUrl = `${COMIX_BASE_URL}/title/${slug}/${chapterId}-chapter-${chapterNumber}`;
  const r = await proxyFetch(targetUrl);
  const html = await r.text();

  const jsonString = extractJsonArray(html, 'images');
  const parsed = JSON.parse(jsonString);

  return parsed.map((img: { url: string; width?: number; height?: number }) => ({
    url: img.url,
    width: img.width || 0,
    height: img.height || 0,
  }));
}
