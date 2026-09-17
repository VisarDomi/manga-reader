import { expect, it } from 'vitest';
import { remainingHomePages } from '../../src/core/home-pages';
import type { HomePage } from '../../src/provider/types';

function page(n: number, last = 6): HomePage {
    return { series: [], total: n, nextCursor: n < last ? String(n + 1) : null,
        prefetchCursors: Array.from({ length: Math.min(3, last - n) }, (_, i) => String(n + i + 1)) };
}

it('fetches three pages concurrently and emits in order with a bounded buffer', async () => {
    const calls: string[] = [], resolve = new Map<string, (page: HomePage) => void>();
    const pages = remainingHomePages(page(1), cursor => {
        calls.push(cursor);
        return new Promise(done => resolve.set(cursor, done));
    });
    const second = pages.next();
    expect(calls).toEqual(['2', '3', '4']);
    resolve.get('4')!(page(4)); resolve.get('3')!(page(3));
    await Promise.resolve();
    expect(calls).toHaveLength(3);
    resolve.get('2')!(page(2));
    expect((await second).value?.total).toBe(2);
    expect((await pages.next()).value?.total).toBe(3);
    expect(calls).toEqual(['2', '3', '4', '5']);
    expect((await pages.next()).value?.total).toBe(4);
    expect(calls).toEqual(['2', '3', '4', '5', '6']);
    resolve.get('6')!(page(6)); resolve.get('5')!(page(5));
    expect((await pages.next()).value?.total).toBe(5);
    expect((await pages.next()).value?.total).toBe(6);
    expect((await pages.next()).done).toBe(true);
});

it('follows opaque cursors and source transitions without guessing unknown pages', async () => {
    const calls: string[] = [];
    const pages = remainingHomePages({ series: [], nextCursor: 'latest:2' }, async cursor => {
        calls.push(cursor);
        return { series: [], nextCursor: cursor === 'latest:2' ? 'catalog:1' : null };
    });
    for await (const _page of pages) { /* consume in order */ }
    expect(calls).toEqual(['latest:2', 'catalog:1']);
});

it('reports prefetched failures in order and rejects repeated cursors', async () => {
    const pages = remainingHomePages(page(1), async cursor => {
        if (cursor === '3') throw new Error('Request failed');
        return page(Number(cursor));
    });
    expect((await pages.next()).value?.total).toBe(2);
    await expect(pages.next()).rejects.toThrow('Request failed');
    const repeated = remainingHomePages({ series: [], nextCursor: 'same' }, async () => ({ series: [], nextCursor: 'same' }));
    await repeated.next();
    await expect(repeated.next()).rejects.toThrow('Provider repeated catalog cursor same');
});
