// Worker-safe asura remote history parsing (was in asura.ts).
import type { RemoteSeriesHistory } from './types';

function record(value: unknown, context: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`Asura ${context} is not an object`);
    }
    return value as Record<string, unknown>;
}

function historyChapter(value: unknown, historySlug: string): number {
    if (typeof value !== 'number' && typeof value !== 'string') {
        throw new Error(`Asura read history for ${historySlug} contains a non-number`);
    }
    const chapter = Number(value);
    if (!Number.isFinite(chapter) || chapter <= 0) {
        throw new Error(`Asura read history for ${historySlug} contains an invalid chapter`);
    }
    return chapter;
}

export function parseAsuraRemoteHistory(value: unknown): RemoteSeriesHistory[] {
    const envelope = record(value, 'read history response');
    if (!('data' in envelope)) throw new Error('Asura read history response is missing data');
    const data = record(envelope.data, 'read history data');
    return Object.entries(data).map(([historySlug, raw]) => {
        const values = Array.isArray(raw) ? raw : [raw];
        if (values.length === 0) throw new Error(`Asura read history for ${historySlug} is empty`);
        const latest = Math.max(...values.map(item => historyChapter(item, historySlug)));
        return {
            seriesId: historySlug,
            readThroughChapterId: String(latest),
            resumeChapterId: String(latest),
        };
    });
}
