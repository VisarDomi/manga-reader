import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ saved: new Map<string, unknown>() }));
vi.mock('../../src/app/native', () => ({
    native: vi.fn(async (command: string, args: { key: string; value?: unknown }) => {
        if (command === 'chapter-read') return state.saved.get(args.key) ?? null;
        if (command === 'chapter-write') state.saved.set(args.key, args.value);
        return {};
    }),
    imageURL: (url: string) => url,
    localURL: (url: string) => url,
}));

const key = (slug: string) => JSON.stringify(['chapters', slug]);
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

beforeEach(() => { vi.resetModules(); vi.restoreAllMocks(); state.saved.clear(); });

it('gives readers a fresh chapter list while background preparation reuses the latest', async () => {
    const { selected, chapterList, onChapterListChange } = await import('../../src/app/provider');
    let release!: (chapters: { chapterId: string }[]) => void;
    const fetchList = vi.spyOn(selected, 'fetchChaptersNewestFirst')
        .mockReturnValueOnce(new Promise(resolve => { release = resolve; }))
        .mockResolvedValue([{ chapterId: '2' }, { chapterId: '1' }]);
    const changed = vi.fn();
    onChapterListChange(changed);

    // Background preparation and the opening reader share one pending request.
    const background = chapterList('series', false);
    const reader = chapterList('series');
    release([{ chapterId: '1' }]);
    expect(await background).toEqual([{ chapterId: '1' }]);
    expect(await reader).toEqual([{ chapterId: '1' }]);
    expect(await chapterList('series', false)).toEqual([{ chapterId: '1' }]);
    expect(fetchList).toHaveBeenCalledTimes(1);
    expect(changed).not.toHaveBeenCalled();

    // A reader asks the source again; background work then sees the new release.
    expect(await chapterList('series')).toEqual([{ chapterId: '2' }, { chapterId: '1' }]);
    expect(fetchList).toHaveBeenCalledTimes(2);
    await tick();
    expect(changed).toHaveBeenCalledExactlyOnceWith('series');
    expect(await chapterList('series', false)).toEqual([{ chapterId: '2' }, { chapterId: '1' }]);
    expect(fetchList).toHaveBeenCalledTimes(2);
});

it('keeps every fetched list and answers from it before the source does', async () => {
    const { selected, chapterList, savedChapterList, onChapterListChange } = await import('../../src/app/provider');
    vi.spyOn(selected, 'fetchChaptersNewestFirst').mockResolvedValueOnce([{ chapterId: '1' }]);
    await chapterList('series');
    await tick();
    expect(state.saved.get(key('series'))).toEqual([{ chapterId: '1' }]);

    // A later launch: the saved list answers while the source is still pending.
    vi.resetModules();
    const next = await import('../../src/app/provider');
    let release!: (chapters: { chapterId: string }[]) => void;
    vi.spyOn(next.selected, 'fetchChaptersNewestFirst')
        .mockReturnValue(new Promise(resolve => { release = resolve; }));
    const changed = vi.fn();
    next.onChapterListChange(changed);
    expect(await next.savedChapterList('series')).toEqual([{ chapterId: '1' }]);
    expect(await next.chapterList('series', false)).toEqual([{ chapterId: '1' }]);

    // The source's newer answer replaces it, is kept, and moves the download window.
    release([{ chapterId: '2' }, { chapterId: '1' }]);
    await tick();
    expect(changed).toHaveBeenCalledExactlyOnceWith('series');
    expect(await next.chapterList('series', false)).toEqual([{ chapterId: '2' }, { chapterId: '1' }]);
    expect(state.saved.get(key('series'))).toEqual([{ chapterId: '2' }, { chapterId: '1' }]);
    expect(savedChapterList).toBeTypeOf('function');
    expect(onChapterListChange).toBeTypeOf('function');
});

it('does not keep a failed chapter list for background preparation', async () => {
    const { selected, chapterList } = await import('../../src/app/provider');
    const fetchList = vi.spyOn(selected, 'fetchChaptersNewestFirst')
        .mockRejectedValueOnce(new Error('HTTP 500'))
        .mockResolvedValue([{ chapterId: '1' }]);
    await expect(chapterList('series', false)).rejects.toThrow('HTTP 500');
    expect(await chapterList('series', false)).toEqual([{ chapterId: '1' }]);
    expect(fetchList).toHaveBeenCalledTimes(2);
});

it('extends a kept list with the newer chapters its Home row shows, and keeps that', async () => {
    state.saved.set(key('series'), [{ chapterId: '112' }, { chapterId: '111' }, { chapterId: '110' }]);
    const { selected, chapterList, onChapterListChange, provider } = await import('../../src/app/provider');
    // The source is slow (an expired cache) and still answers with the old list.
    let release!: (chapters: { chapterId: string }[]) => void;
    vi.spyOn(selected, 'fetchChaptersNewestFirst').mockReturnValue(new Promise(resolve => { release = resolve; }));
    vi.spyOn(selected, 'fetchHome').mockResolvedValue({
        nextCursor: null,
        series: [{ slug: 'series', title: 'Series', coverUrl: 'https://example.test/c.webp', chapters: ['113', '112', '111'].map(chapterId => ({
            chapterId, label: chapterId, uploadedAt: null, locked: false, unlockAt: null,
        })) }],
    });
    const changed = vi.fn();
    onChapterListChange(changed);
    expect(await chapterList('series', false)).toEqual([{ chapterId: '112' }, { chapterId: '111' }, { chapterId: '110' }]);

    await provider.fetchHome(null);
    await tick();
    expect(changed).toHaveBeenCalledExactlyOnceWith('series');
    const extended = [{ chapterId: '113' }, { chapterId: '112' }, { chapterId: '111' }, { chapterId: '110' }];
    expect(await chapterList('series', false)).toEqual(extended);
    expect(state.saved.get(key('series'))).toEqual(extended);

    // The source's older answer does not undo it for background preparation.
    release([{ chapterId: '112' }, { chapterId: '111' }, { chapterId: '110' }]);
    await tick();
    expect(await chapterList('series', false)).toEqual(extended);
    await tick();
    expect(state.saved.get(key('series'))).toEqual(extended);
});
