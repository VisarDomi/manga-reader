import { describe, expect, it } from 'vitest';
import { parseValirPages } from '../../src/provider/valir';

// Build an escaped-RSC fixture: the chapter record nests the pages array, and
// a chapter-list record with the SAME chapter id appears elsewhere — the
// shape that broke the old field-order regex (it spanned from the chapter id
// into page 1's record and consumed the real page id).
function esc(json: string): string {
    return json.replace(/"/g, '\\"');
}

function fixture(pagesJson: string): string {
    return esc('{"chapter":{"id":"chapter-id-1","number":16,')
        + esc('"title":"Chapter 16","content":"","pages":[')
        + pagesJson
        + esc('],"someOther":true}')
        + esc('{"id":"chapter-id-1","number":16,"isLocked":false}')
        + esc('{"id":"chapter-id-2","number":17,"isLocked":false}');
}

describe('parseValirPages', () => {
    it('extracts the chapter pages with their real ids', () => {
        const html = fixture([
            '{"id":"page-1","pageNumber":1,"kind":"CONTENT","isRedacted":false,',
            '"imageUrl":"https://media.test/p1.webp","width":800,"height":10000,',
            '"isEncrypted":true,"tiles":[{"x":0,"y":0}]},',
            '{"id":"page-2","pageNumber":2,"kind":"CONTENT","isRedacted":false,',
            '"imageUrl":"https://media.test/p2.webp","width":800,"height":4327,',
            '"isEncrypted":false}',
        ].join(''));

        const pages = parseValirPages(html);
        expect(pages).toEqual([
            { pageId: 'page-1', pageNumber: 1, url: 'https://media.test/p1.webp', width: 800, height: 10000, encrypted: true },
            { pageId: 'page-2', pageNumber: 2, url: 'https://media.test/p2.webp', width: 800, height: 4327, encrypted: false },
        ]);
    });

    it('rejects a page without pages data', () => {
        expect(() => parseValirPages('no chapter here')).toThrow(/Could not find chapter/);
    });
});
