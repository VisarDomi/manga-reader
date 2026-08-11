import { describe, expect, it } from 'vitest';
import { isChapterUnavailable } from '../../src/core/http';

describe('chapter HTTP classification', () => {
    it('recognizes missing and redirected chapter responses', () => {
        expect(isChapterUnavailable(new Response(null, { status: 404 }))).toBe(true);
        expect(isChapterUnavailable({ ok: true, redirected: true, status: 200 } as Response)).toBe(true);
    });

    it.each([401, 403, 429, 500])('throws for unexpected HTTP %s responses', status => {
        expect(() => isChapterUnavailable(new Response(null, { status })))
            .toThrow(`Chapter request failed: ${status}`);
    });

    it('accepts successful chapter responses', () => {
        expect(isChapterUnavailable(new Response(null, { status: 200 }))).toBe(false);
    });
});
