import { describe, expect, it } from 'vitest';
import { asuraHistoryId } from '../../src/provider/asura';

describe('asuraHistoryId', () => {
    it('drops the rotating hex suffix', () => {
        expect(asuraHistoryId('absolute-regression-b60d532c')).toBe('absolute-regression');
        expect(asuraHistoryId('my-slain-dragon-bride-7e1f454a')).toBe('my-slain-dragon-bride');
    });

    it('keeps bare slugs untouched', () => {
        expect(asuraHistoryId('absolute-regression')).toBe('absolute-regression');
    });

    it('keeps non-hex word suffixes untouched', () => {
        expect(asuraHistoryId('some-series')).toBe('some-series');
        expect(asuraHistoryId('reborn-on-the-demonic-cult-battlefield')).toBe('reborn-on-the-demonic-cult-battlefield');
    });
});
