import type { HomePage } from '../provider/types';

// Buffer at most three pages, including completed pages awaiting their turn.
// Cursors remain opaque: only the provider knows which pages actually exist.
export async function* remainingHomePages(
    first: HomePage,
    fetchPage: (cursor: string) => Promise<HomePage>,
): AsyncGenerator<HomePage> {
    const pending = new Map<string, Promise<{ page: HomePage } | { error: unknown }>>();
    const seen = new Set<string>();
    let previous = first;
    while (previous.nextCursor !== null) {
        const next = previous.nextCursor;
        if (seen.has(next)) throw new Error(`Provider repeated catalog cursor ${next}`);
        for (const cursor of [next, ...(previous.prefetchCursors ?? [])]) {
            if (pending.size === 3) break;
            if (seen.has(cursor) || pending.has(cursor)) continue;
            // Observe errors immediately even when this page finishes out of order.
            pending.set(cursor, fetchPage(cursor).then(page => ({ page }), error => ({ error })));
        }
        const result = await pending.get(next)!;
        pending.delete(next);
        if ('error' in result) throw result.error;
        seen.add(next);
        previous = result.page;
        yield previous;
    }
}
