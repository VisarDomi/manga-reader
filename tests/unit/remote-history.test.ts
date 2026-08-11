import { describe, expect, it } from 'vitest';
import { parseAsuraRemoteHistory } from '../../src/provider/asura';
import { parseValirRemoteHistory } from '../../src/provider/valir';

describe('remote reading history', () => {
    it('normalizes Asura chapter history into a provider-owned read boundary', () => {
        expect(parseAsuraRemoteHistory({
            data: {
                'internal-series-a': [7, '8', 7.5],
                'internal-series-b': 3,
            },
        })).toEqual([
            {
                seriesId: 'internal-series-a',
                readThroughChapterId: '8',
                resumeChapterId: '8',
            },
            {
                seriesId: 'internal-series-b',
                readThroughChapterId: '3',
                resumeChapterId: '3',
            },
        ]);
    });

    it('uses Valir last-chapter progress without confusing it with overall series progress', () => {
        expect(parseValirRemoteHistory({
            series: [{
                slug: 'internal-slug',
                urlSlug: 'public-slug',
                highestChapter: 12,
                progressPercent: 40,
                lastChapter: { number: 11, progress: 63 },
            }],
        })).toEqual([{
            seriesId: 'public-slug',
            readThroughChapterId: '12',
            resumeChapterId: '11',
            resumePercent: 63,
        }]);
    });

    it('rejects malformed provider history instead of treating it as empty', () => {
        expect(() => parseAsuraRemoteHistory({ data: { broken: [] } })).toThrow('is empty');
        expect(() => parseValirRemoteHistory({ series: [{
            slug: 'series',
            highestChapter: 2,
            lastChapter: { number: 2, progress: 101 },
        }] })).toThrow('lastChapter.progress is invalid');
    });
});
