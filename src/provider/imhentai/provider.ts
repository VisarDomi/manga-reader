import {Provider, SearchPage, GalleryMeta, GalleryFile, Handler} from '../types';
import {DOMAIN, LANG_PARAM} from "./constants";
import {buildImhentaiSearchUrl, extractAll, extractBetween, fetchText, getFiles} from "./decoder";

const PAGE_SIZE = 20;

export const provider: Provider = {
    name: 'imhentai',

    async init(): Promise<void> {
        // No autocomplete to wire up
    },

    matchRoute(pathname: string, search: string, _hash: string) {
        if (pathname === '/' || pathname === '') {
            return { handler: Handler.Home };
        }

        if (pathname.startsWith('/search/')) {
            const params = new URLSearchParams(search);
            const key = params.get('key') ?? '';
            const page = parseInt(params.get('page') ?? '1');
            const enabled = Object.entries(LANG_PARAM).filter(([, code]) => params.get(code) === '1');
            if (enabled.length === 1) {
                const [name] = enabled[0];
                const query = key ? `${key},language:${name}` : `language:${name}`;
                return { handler: Handler.Search, query, page };
            }
            return { handler: Handler.Search, query: key, page };
        }

        const tagPages: Record<string, string> = {
            '/tag/': 'tag',
            '/language/': 'language',
            '/artist/': 'artist',
            '/parody/': 'parody',
            '/category/': 'category',
            '/character/': 'character',
            '/group/': 'group',
        };

        for (const [prefix, ns] of Object.entries(tagPages)) {
            if (pathname.startsWith(prefix)) {
                const name = decodeURIComponent(pathname.slice(prefix.length)).replace(/\/$/, '').replace(/-/g, ' ');
                const params = new URLSearchParams(search);
                const page = parseInt(params.get('page') ?? '1');
                return { handler: Handler.Search, query: ns === 'tag' ? name : `${ns}:${name}`, page };
            }
        }

        if (pathname.startsWith('/view/')) {
            const parts = pathname.replace(/^\/view\//, '').replace(/\/$/, '').split('/');
            const gid = Number(parts[0]);
            const page = parts.length >= 2 ? parseInt(parts[1]) : 1;
            if (!isNaN(gid)) return { handler: Handler.Reader, gid, index: page - 1 };
        }

        return null;
    },
    async search(rawQuery: string, page: number): Promise<SearchPage> {
        // exclusion warning
        const q = rawQuery.trim();
        if (q.includes(' -') || q.startsWith('-')) {
            const key = '__imh_exclusion_warned';
            if (!(window as unknown as Record<string, boolean>)[key]) {
                (window as unknown as Record<string, boolean>)[key] = true;
                const banner = document.createElement('div');
                banner.className = 'hs-page-bar';
                banner.textContent = 'imhentai does not support excluding tags (-). Only positive terms are used.';
                banner.style.color = '#c88';
                const grid = document.getElementById('hs-grid');
                if (grid?.parentNode) grid.parentNode.insertBefore(banner, grid);
            }
        }

        const url = buildImhentaiSearchUrl(q, page);


        const html = await fetchText(url);

        // Extract gallery IDs: href="/gallery/NNN"
        const ids: number[] = [];
        const hrefs = extractAll(html, 'href="/gallery/', '"');
        let prev = -1;
        for (const h of hrefs) {
            const id = parseInt(h);
            if (!isNaN(id) && id !== prev) ids.push(id);
            prev = id;
        }

        // Count pages from pagination links
        const pageLinks = extractAll(html, "class='page-link' href='", "'");
        let totalPages = page;
        for (const href of pageLinks) {
            const m = href.match(/[?&]page=(\d+)/);
            if (m) totalPages = Math.max(totalPages, parseInt(m[1]));
        }
        if (totalPages === page && ids.length === 0) totalPages = 0;

        return { ids, totalResults: totalPages * PAGE_SIZE, pageSize: PAGE_SIZE };
    },
    goToPage(rawQuery: string, page: number): void {
        history.replaceState(null, '', buildImhentaiSearchUrl(rawQuery, page));
    },

    async fetchMeta(gid: number): Promise<GalleryMeta> {
        const html = await fetchText(`https://${DOMAIN}/gallery/${gid}/`);

        // Title
        const h1 = extractBetween(html, '<h1>', '</h1>');
        const title = h1 ? h1.value.replace(/<[^>]*>/g, '').trim() : '';

        // Japanese title
        const sub = extractBetween(html, 'class="subtitle">', '<');
        const titleJpn = sub ? sub.value.trim() : '';

        // Metadata section
        const infoStart = html.indexOf('class="galleries_info"');
        const infoEnd = html.indexOf('</ul>', infoStart);
        const chunk = infoStart !== -1 && infoEnd !== -1 ? html.slice(infoStart, infoEnd) : html;

        function extractNS(ns: string): string[] {
            const results: string[] = [];
            let pos = 0;
            while (true) {
                const m = extractBetween(chunk, "href='/" + ns + "/", "'", pos);
                if (!m) break;
                const tagStart = chunk.indexOf('>', m.nextIndex) + 1;
                const tagEnd = chunk.indexOf('</a>', tagStart);
                if (tagEnd === -1) break;
                let tag = chunk.slice(tagStart, tagEnd).replace(/<[^>]*>/g, '').trim();
                tag = tag.replace(/\s+\d+$/, '');
                if (tag) results.push(tag);
                pos = tagEnd;
            }
            return results;
        }

        const artists = extractNS('artist');
        const groups = extractNS('group');
        const parody = extractNS('parody');
        const characters = extractNS('character');
        const tags = extractNS('tag');
        const languages = extractNS('language');

        // Category
        const cat = extractBetween(chunk, "href='/category/", "/'");
        const type = cat ? cat.value : '';

        // Posted date
        let date = '';
        const dm = extractBetween(html, '>Posted: ', '</li>');
        if (dm) date = dm.value.trim();
        const files = getFiles(html, gid);

        return {
            title,
            title_jpn: titleJpn,
            type,
            language: languages[0] ?? '',
            date,
            artists,
            groups,
            parody,
            characters,
            tags: tags.map(t => ({ tag: t })),
            files,
        };
    },

    readerUrl(gid: number, index?: number): string {
        if (index !== undefined) return `https://${DOMAIN}/view/${gid}/${index + 1}/`;
        return `https://${DOMAIN}/view/${gid}/1/`;
    },

    searchUrl(rawQuery: string, page?: number): string {
        return buildImhentaiSearchUrl(rawQuery, page);
    },

    tagSearchUrl(ns: string, value: string, language: string): string {
        const query = ns === 'language' ? `language:${value}` : `language:${language},${value}`;
        return buildImhentaiSearchUrl(query);
    },

    thumbUrl(file: GalleryFile): string {
        return file.key;
    },

    async imageUrls(files: GalleryFile[]): Promise<string[]> {
        return files.map(f => f.key);
    },
};
