import type { ChapterMeta } from '../provider/types';

// Chapters that `newer` (newest first: a Home row, or an earlier list) shows ahead
// of `list`, prepended only when the rest of `newer` continues `list` exactly for
// at least two chapters. That holds for a run of the newest chapters, not for a
// selection that skips some, so a chapter can never be skipped. Otherwise `list`
// is returned unchanged (the same array).
export function withNewerChapters(list: ChapterMeta[], newer: ChapterMeta[]): ChapterMeta[] {
    const head = newer.findIndex(chapter => chapter.chapterId === list[0]?.chapterId);
    if (head <= 0) return list;
    const overlap = Math.min(newer.length - head, list.length);
    if (overlap < 2) return list;
    for (let i = 0; i < overlap; i++) {
        if (newer[head + i].chapterId !== list[i].chapterId) return list;
    }
    return [...newer.slice(0, head), ...list];
}
