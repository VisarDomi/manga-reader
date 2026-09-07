// Compute worker entry. Must never import DOM, window, or document APIs.
// Runs in a dedicated worker spawned from a Blob by the main thread.
// Ops are handled serially so save ordering is a hard invariant.

import type { ComputeRequest, ComputeResponse } from './messages';
import type { RemoteSeriesHistory } from '../../provider/types';
import { createChapterProgress } from './progress';
import { resolveHistory, type CardInput } from './history';
import { loadProgress } from './migrations';
import { progressPut, databaseBackup, restoreDatabaseBackup } from './store';
import {
    fetchProviderHome,
    fetchProviderRemoteHistory,
    trackProviderChapter,
} from '../../provider/worker';
import { setWorkerContext } from './context';
import type { ChapterData } from '../../provider/types';
import { backupControl, type BackupCommand } from '../backup-engine';
import { validateDatabaseBackup } from './backup';

type Outcome =
    | { ok: true; value: unknown }
    | { ok: false; error: string };

async function handle(request: ComputeRequest): Promise<Outcome> {
    try {
        switch (request.op) {
            case 'backup-control':
                return { ok: true, value: await backupControl(request.payload as BackupCommand, {
                    capture: async () => { await writeQueue; await loadProgress(); return databaseBackup(); },
                    restore: async data => {
                        const restored = (writeQueue ?? Promise.resolve()).then(() => restoreDatabaseBackup(data));
                        writeQueue = restored.catch(() => {});
                        await restored;
                    },
                    stats(data) {
                        const stores = validateDatabaseBackup(data).indexedDB;
                        return `${stores.progress.length} series resume positions, ${stores.tokens.length} session records, ${stores.metadata.length} metadata records`;
                    },
                }) };
            case 'backup-export':
                await loadProgress();
                return { ok: true, value: await databaseBackup() };
            case 'backup-import':
                await restoreDatabaseBackup(request.payload);
                return { ok: true, value: undefined };
            case 'save-progress': {
                const payload = request.payload as Record<string, unknown> | undefined;
                if (
                    typeof payload?.provider !== 'string'
                    || typeof payload.seriesSlug !== 'string'
                    || typeof payload.chapterId !== 'string'
                    || typeof payload.imageIndex !== 'number'
                    || typeof payload.totalImages !== 'number'
                ) {
                    throw new Error('save-progress requires complete progress data');
                }
                const entry = createChapterProgress(
                    payload.provider,
                    payload.seriesSlug,
                    payload.chapterId,
                    payload.imageIndex,
                    payload.totalImages,
                );
                await progressPut(entry);
                return { ok: true, value: entry };
            }

            case 'cookie-snapshot': {
                const payload = request.payload as { cookies?: unknown; href?: unknown } | undefined;
                if (typeof payload?.cookies !== 'string' || typeof payload.href !== 'string') {
                    throw new Error('cookie-snapshot requires cookies and href');
                }
                setWorkerContext({
                    cookies: payload.cookies,
                    href: payload.href,
                });
                return { ok: true, value: undefined };
            }

            case 'remote-history': {
                const payload = request.payload as { provider?: unknown } | undefined;
                if (typeof payload?.provider !== 'string') throw new Error('remote-history requires a provider key');
                return { ok: true, value: await fetchProviderRemoteHistory(payload.provider) };
            }

            case 'track-chapter': {
                const payload = request.payload as { provider?: unknown; data?: ChapterData } | undefined;
                if (typeof payload?.provider !== 'string' || !payload.data) {
                    throw new Error('track-chapter requires provider data');
                }
                await trackProviderChapter(payload.provider, payload.data);
                return { ok: true, value: undefined };
            }

            case 'fetch-home': {
                const payload = request.payload as { provider?: unknown; cursor?: unknown } | undefined;
                if (typeof payload?.provider !== 'string') {
                    throw new Error('fetch-home requires a provider key');
                }
                if (payload.cursor !== null && typeof payload.cursor !== 'string') {
                    throw new Error('fetch-home requires a string or null cursor');
                }
                const cursor = payload.cursor;
                const page = await fetchProviderHome(payload.provider, cursor);
                return { ok: true, value: page };
            }

            case 'history-resolve': {
                const payload = request.payload as {
                    cards?: CardInput[];
                    remoteHistory?: RemoteSeriesHistory[];
                } | undefined;
                if (!Array.isArray(payload?.cards) || !Array.isArray(payload?.remoteHistory)) {
                    throw new Error('history-resolve requires cards and remoteHistory arrays');
                }
                const result = resolveHistory({
                    cards: payload.cards,
                    remoteHistory: payload.remoteHistory,
                    progress: await loadProgress(),
                });
                return { ok: true, value: result };
            }

            default:
                throw new Error(`Unknown op: ${request.op}`);
        }
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

function respond(id: number, outcome: Outcome): void {
    const response: ComputeResponse = outcome.ok
        ? { id, ok: true, value: outcome.value }
        : { id, ok: false, error: outcome.error };
    (self as unknown as Worker).postMessage(response);
}

// State-dependent work is serialized so a history read sent after a progress
// save cannot observe the previous local resume position.
let writeQueue: Promise<void> | null = null;
const WRITE_OPS: ReadonlySet<string> = new Set([
    'backup-export',
    'backup-import',
    'save-progress',
    'history-resolve',
    'track-chapter',
]);

self.onmessage = (event: MessageEvent<ComputeRequest>) => {
    const request = event.data;
    const task = async (): Promise<void> => {
        respond(request.id, await handle(request));
    };
    if (WRITE_OPS.has(request.op)) {
        writeQueue = (writeQueue ?? Promise.resolve()).then(task);
    } else {
        void task();
    }
};
