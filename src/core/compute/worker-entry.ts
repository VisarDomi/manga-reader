// Compute worker entry. Must never import DOM, window, or document APIs.
// Runs in a dedicated worker spawned from a Blob by the main thread.
// Ops are handled serially so save ordering is a hard invariant.

import type { ComputeRequest, ComputeResponse } from './messages';
import type { RemoteSeriesHistory } from '../../provider/types';
import {
    buildProgressIndex,
    createChapterProgress,
    type ChapterProgress,
} from './progress';
import { resolveHistory, type CardInput } from './history';
import { progressGetAll, progressPut } from './store';

interface WorkerState {
    progress: ChapterProgress[];
    byChapter: Map<string, ChapterProgress>;
    bySeries: Map<string, ChapterProgress[]>;
}

interface Outcome {
    ok: boolean;
    value?: unknown;
    error?: string;
}

let state: WorkerState | null = null;

async function ensureState(): Promise<WorkerState> {
    if (state !== null) return state;
    const progress = await progressGetAll();
    const { byChapter, bySeries } = buildProgressIndex(progress);
    state = { progress, byChapter, bySeries };
    return state;
}

function rebuildState(progress: ChapterProgress[]): void {
    const { byChapter, bySeries } = buildProgressIndex(progress);
    state = { progress, byChapter, bySeries };
}

async function handle(request: ComputeRequest): Promise<Outcome> {
    try {
        switch (request.op) {
            case 'save-progress': {
                const payload = request.payload as Record<string, unknown> | undefined;
                const current = await ensureState();
                const entry = createChapterProgress(
                    String(payload?.provider),
                    String(payload?.seriesSlug),
                    String(payload?.chapterId),
                    Number(payload?.imageIndex),
                    Number(payload?.totalImages),
                );
                await progressPut(entry);
                const next = current.progress.filter(item => item.id !== entry.id);
                next.push(entry);
                rebuildState(next);
                return { ok: true, value: entry };
            }

            case 'history-resolve': {
                const payload = request.payload as {
                    cards?: CardInput[];
                    remoteHistory?: RemoteSeriesHistory[];
                } | undefined;
                if (!Array.isArray(payload?.cards) || !Array.isArray(payload?.remoteHistory)) {
                    throw new Error('history-resolve requires cards and remoteHistory arrays');
                }
                const current = await ensureState();
                const result = resolveHistory({
                    cards: payload.cards,
                    remoteHistory: payload.remoteHistory,
                    progress: current.progress,
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
    const response: ComputeResponse = { id, ok: outcome.ok, value: outcome.value, error: outcome.error };
    (self as unknown as Worker).postMessage(response);
}

let queue: Promise<void> = Promise.resolve();

self.onmessage = (event: MessageEvent<ComputeRequest>) => {
    const request = event.data;
    queue = queue
        .then(async () => respond(request.id, await handle(request)))
        .catch(error => {
            respond(request.id, {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        });
};
