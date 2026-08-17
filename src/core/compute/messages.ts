// Wire protocol between the main thread and the compute worker.
// Both sides must stay DOM-free and serializable.

import type { RemoteSeriesHistory } from '../../provider/types';
import type { CardInput, CardResolution } from './history';
import type { ChapterProgress } from './progress';

export interface ComputeRequest {
    id: number;
    op: string;
    payload?: unknown;
}

export interface ComputeResponse {
    id: number;
    ok: boolean;
    value?: unknown;
    error?: string;
}

export interface SaveProgressPayload {
    provider: string;
    seriesSlug: string;
    chapterId: string;
    imageIndex: number;
    totalImages: number;
}

export interface HistoryResolvePayload {
    cards: CardInput[];
    remoteHistory: RemoteSeriesHistory[];
}

export interface OpTypes {
    'save-progress': { payload: SaveProgressPayload; result: ChapterProgress };
    'history-resolve': { payload: HistoryResolvePayload; result: CardResolution[] };
}
