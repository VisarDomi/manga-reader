import { expect, it } from 'vitest';
import { withNewerChapters } from '../../src/core/chapter-list';

const chapters = (...ids: number[]) => ids.map(id => ({ chapterId: String(id) }));
const ids = (list: { chapterId: string }[]) => list.map(chapter => Number(chapter.chapterId));

it('adds chapters ahead of a list when the rest continues it', () => {
    expect(ids(withNewerChapters(chapters(112, 111, 110), chapters(113, 112, 111, 110, 109)))).toEqual([113, 112, 111, 110]);
    expect(ids(withNewerChapters(chapters(112, 111, 110), chapters(114, 113, 112, 111)))).toEqual([114, 113, 112, 111, 110]);
});

it('keeps the list when the newer run skips chapters or barely overlaps', () => {
    const list = chapters(16, 15, 14);
    // A Home row that shows a selection, not the newest run (QiScans: 20, 16, 9).
    expect(withNewerChapters(list, chapters(20, 16, 9))).toBe(list);
    // One shared chapter is not enough to show the run is contiguous.
    expect(withNewerChapters(list, chapters(17, 16))).toBe(list);
});

it('keeps the list when it is already as new, or unrelated', () => {
    const list = chapters(113, 112, 111);
    expect(withNewerChapters(list, chapters(113, 112, 111))).toBe(list);
    expect(withNewerChapters(list, chapters(112, 111))).toBe(list);
    expect(withNewerChapters(list, chapters(5, 4))).toBe(list);
    expect(withNewerChapters([], chapters(2, 1))).toEqual([]);
});
