import { describe, expect, it } from 'vitest';
import { parseAsuraRemoteHistory } from '../../src/provider/asura-remote';

describe('remote reading history', () => {
    it('preserves Asura read chapter identities explicitly', () => {
        expect(parseAsuraRemoteHistory({
            data: {
                'internal-series-a': [7, '8', 7.5],
                'internal-series-b': 3,
            },
        })).toEqual([
            {
                seriesId: 'internal-series-a',
                readChapterIds: ['7', '8', '7.5'],
                resumeChapterId: '8',
            },
            {
                seriesId: 'internal-series-b',
                readChapterIds: ['3'],
                resumeChapterId: '3',
            },
        ]);
    });

    it('rejects malformed provider history instead of treating it as empty', () => {
        expect(() => parseAsuraRemoteHistory({ data: { broken: [] } })).toThrow('is empty');
    });
});
