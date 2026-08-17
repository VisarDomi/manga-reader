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
import { fetchCatalogHome } from './catalog';
import {
    fetchAsuraRemoteHistory,
    fetchValirRemoteHistory,
    startWorkerTokenManagers,
    trackAsuraChapter,
    trackValirPage,
} from './token';
import { setWorkerContext } from './context';
import type { ChapterData, ChapterMeta } from '../../provider/types';

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

            case 'cookie-snapshot': {
                const payload = request.payload as { cookies?: unknown; pathname?: unknown; href?: unknown } | undefined;
                setWorkerContext({
                    cookies: typeof payload?.cookies === 'string' ? payload.cookies : '',
                    pathname: typeof payload?.pathname === 'string' ? payload.pathname : '/',
                    href: typeof payload?.href === 'string' ? payload.href : '',
                });
                return { ok: true, value: undefined };
            }

            case 'lifecycle': {
                const payload = request.payload as { hidden?: unknown } | undefined;
                setWorkerContext({ hidden: payload?.hidden === true });
                return { ok: true, value: undefined };
            }

            case 'remote-history': {
                const payload = request.payload as { provider?: unknown } | undefined;
                if (payload?.provider === 'asurascans') {
                    return { ok: true, value: await fetchAsuraRemoteHistory() };
                }
                if (payload?.provider === 'valirscans') {
                    return { ok: true, value: await fetchValirRemoteHistory() };
                }
                throw new Error('remote-history requires an asura/valir provider key');
            }

            case 'track-chapter': {
                const payload = request.payload as { provider?: unknown; data?: ChapterData } | undefined;
                if (payload?.provider !== 'asurascans' || !payload?.data) {
                    throw new Error('track-chapter requires asura provider data');
                }
                await trackAsuraChapter(payload.data);
                return { ok: true, value: undefined };
            }

            case 'track-page': {
                const payload = request.payload as {
                    provider?: unknown;
                    data?: ChapterData;
                    imageIndex?: string;
                    chaptersNewestFirst?: ChapterMeta[];
                } | undefined;
                if (payload?.provider !== 'valirscans' || !payload?.data) {
                    throw new Error('track-page requires valir provider data');
                }
                await trackValirPage(
                    payload.data,
                    payload.imageIndex ?? '0',
                    payload.chaptersNewestFirst ?? [],
                );
                return { ok: true, value: undefined };
            }

            case 'fetch-home': {
                const payload = request.payload as { provider?: unknown; cursor?: unknown } | undefined;
                if (typeof payload?.provider !== 'string') {
                    throw new Error('fetch-home requires a provider key');
                }
                const cursor = payload.cursor === null || payload.cursor === undefined
                    ? null
                    : String(payload.cursor);
                const page = await fetchCatalogHome(payload.provider, cursor);
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

// The op queue initializes lazily and token managers start on the first
// session signal — nothing runs at module scope except this entry handler.
let queue: Promise<void> | null = null;
let tokenManagersStarted = false;

self.onmessage = (event: MessageEvent<ComputeRequest>) => {
    const request = event.data;
    if (request.op === 'cookie-snapshot' && !tokenManagersStarted) {
        tokenManagersStarted = true;
        startWorkerTokenManagers();
    }
    const chain = queue ?? Promise.resolve();
    queue = chain
        .then(async () => respond(request.id, await handle(request)))
        .catch(error => {
            respond(request.id, {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        });
};
