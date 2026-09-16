import type { PCCommand } from './manual-pc';
// Wire protocol between the main thread and the compute worker.
// Both sides must stay DOM-free and serializable.

import type {
    HomePage,
} from '../../provider/types';
import type { CardInput, CardResolution } from './history';
import type { ChapterProgress } from './progress';
import type { DatabaseBackup } from './backup';

export interface ComputeRequest {
    id: number;
    op: string;
    payload?: unknown;
}

export type ComputeResponse =
    | { id: number; ok: true; value: unknown }
    | { id: number; ok: false; error: string };

interface SaveProgressPayload {
    provider: string;
    seriesSlug: string;
    chapterId: string;
    imageIndex: number;
    totalImages: number;
}

interface HistoryResolvePayload {
    cards: CardInput[];
}

interface FetchHomePayload {
    provider: string;
    cursor: string | null;
}

interface SnapshotPayload {
    href: string;
}

export interface OpTypes {
    'manual-pc': { payload: PCCommand; result: boolean };
    'backup-export': { payload: undefined; result: DatabaseBackup };
    'backup-import': { payload: unknown; result: undefined };
    'save-progress': { payload: SaveProgressPayload; result: ChapterProgress };
    'history-resolve': { payload: HistoryResolvePayload; result: CardResolution[] };
    'fetch-home': { payload: FetchHomePayload; result: HomePage };
    'page-context': { payload: SnapshotPayload; result: undefined };
}
