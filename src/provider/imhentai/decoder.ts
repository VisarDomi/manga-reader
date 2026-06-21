import {DOMAIN, LANG_PARAM} from "./constants";
import {GalleryFile} from "../types";

export async function fetchText(url: string): Promise<string> {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw Error(`HTTP ${resp.status}`);
    return resp.text();
}

export function extractBetween(html: string, start: string, end: string, fromIndex = 0): { value: string; nextIndex: number } | null {
    const s = html.indexOf(start, fromIndex);
    if (s === -1) return null;
    const e = html.indexOf(end, s + start.length);
    if (e === -1) return null;
    return { value: html.slice(s + start.length, e), nextIndex: e + end.length };
}

export function extractAll(html: string, start: string, end: string): string[] {
    const results: string[] = [];
    let idx = 0;
    while (true) {
        const m = extractBetween(html, start, end, idx);
        if (!m) break;
        results.push(m.value);
        idx = m.nextIndex;
    }
    return results;
}



interface ParsedQuery {
    language: string | null;
    namespaces: { ns: string; value: string }[];
    keywords: string[];
}

function parseImhentaiQuery(raw: string): ParsedQuery {
    const terms = raw.split(',').map(t => t.trim()).filter(Boolean);
    const namespaces: { ns: string; value: string }[] = [];
    const keywords: string[] = [];
    let language: string | null = null;

    for (const term of terms) {
        const colon = term.indexOf(':');
        if (colon === -1) {
            keywords.push(term);
            continue;
        }
        const ns = term.slice(0, colon);
        const value = term.slice(colon + 1);
        if (ns === 'language') {
            language = value;
        } else {
            namespaces.push({ ns, value });
        }
    }

    return { language, namespaces, keywords };
}

export function buildImhentaiSearchUrl(query: string, page?: number): string {
    let { language, namespaces, keywords } = parseImhentaiQuery(query.trim());

    // path-based: single namespace or language-only
    if (!language && keywords.length === 0 && namespaces.length === 1) {
        let url = `https://${DOMAIN}/${namespaces[0].ns}/${encodeURIComponent(namespaces[0].value.replace(/\s+/g, '-'))}/`;
        if (page !== undefined) url += '?page=' + page;
        return url;
    }
    if (language && namespaces.length === 0 && keywords.length === 0) {
        let url = `https://${DOMAIN}/language/${encodeURIComponent(language.replace(/\s+/g, '-'))}/`;
        if (page !== undefined) url += '?page=' + page;
        return url;
    }

    // namespace + language → convert namespace to keyword for search endpoint
    if (language && namespaces.length === 1 && keywords.length === 0) {
        keywords = [namespaces[0].value];
    }

    // search endpoint
    const params = new URLSearchParams();
    params.set('lt', '1'); params.set('pp', '0');
    params.set('m', '1'); params.set('d', '1'); params.set('w', '1');
    params.set('i', '1'); params.set('a', '1'); params.set('g', '1');
    params.set('apply', 'Search');
    params.set('dl', '0'); params.set('tr', '0');

    // language params — all enabled for keyword search, or specific if set
    if (language) {
        const langCode = LANG_PARAM[language] ?? 'jp';
        for (const code of Object.values(LANG_PARAM)) {
            params.set(code, code === langCode ? '1' : '0');
        }
    } else {
        for (const code of Object.values(LANG_PARAM)) {
            params.set(code, '1');
        }
    }

    params.set('key', keywords.map(k => k.replace(/[_-]/g, ' ')).join(','));

    let url = `https://${DOMAIN}/search/?${params.toString()}`;
    if (page !== undefined) url += '&page=' + page;
    return url;
}

export function getFiles(html: string, gid: number) {
    // ── Images ──────────────────────────────────────────────────
    const srcM = extractBetween(html, 'data-src="', '"');
    const base = srcM ? srcM.value.substring(0, srcM.value.lastIndexOf('/')) + '/' : '';
    const exts: Record<string, string> = {j: 'jpg', p: 'png', g: 'gif', w: 'webp', a: 'avif'};

    const files: GalleryFile[] = [];
    // Try inline JSON
    const jsonM = extractBetween(html, "$.parseJSON('", "'");
    if (jsonM) {
        try {
            const data = JSON.parse(jsonM.value) as Record<string, string>;
            const keys = Object.keys(data).sort((a, b) => parseInt(a) - parseInt(b));
            let idx = 1;
            for (const key of keys) {
                const parts = data[key].split(',');
                const ext = exts[parts[0]] ?? 'jpg';
                const url = `${base}${idx}.${ext}`;
                files.push({
                    name: `${idx}.${ext}`,
                    key: url,           // full-size URL — unique per file
                    width: parseInt(parts[1]) || 0,
                    height: parseInt(parts[2]) || 0,
                });
                idx++;
            }
        } catch {
            // JSON parse failed — fall through
        }
    }

    // Fallback: load_pages hidden input
    if (files.length === 0) {
        const lp = extractBetween(html, 'id="load_pages" value="', '"');
        const count = lp ? parseInt(lp.value) : 0;
        const viewCount = extractAll(html, 'href="/view/' + gid + '/', '"').length;
        const imageCount = count || viewCount;

        for (let i = 1; i <= imageCount; i++) {
            const url = `${base}${i}.jpg`;
            files.push({
                name: `${i}.jpg`,
                key: url,               // full-size URL
                width: 0,
                height: 0,
            });
        }
    }
    return files;
}
