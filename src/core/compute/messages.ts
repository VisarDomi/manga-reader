// Wire protocol between the main thread and the compute worker.
// Both sides must stay DOM-free and serializable.

import type {
    ChapterData,
    ChapterMeta,
    HomePage,
    RemoteSeriesHistory,
} from '../../provider/types';
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

export interface FetchHomePayload {
    provider: string;
    cursor: string | null;
}

export interface SnapshotPayload {
    cookies: string;
    pathname: string;
}

export interface RemoteHistoryPayload {
    provider: string;
}

export interface TrackPayload {
    provider: string;
    data: ChapterData;
    imageIndex?: string;
    chaptersNewestFirst?: ChapterMeta[];
}

export interface OpTypes {
    'save-progress': { payload: SaveProgressPayload; result: ChapterProgress };
    'history-resolve': { payload: HistoryResolvePayload; result: CardResolution[] };
    'fetch-home': { payload: FetchHomePayload; result: HomePage };
    'cookie-snapshot': { payload: SnapshotPayload; result: undefined };
    'lifecycle': { payload: { hidden: boolean }; result: undefined };
    'remote-history': { payload: RemoteHistoryPayload; result: RemoteSeriesHistory[] };
    'track-page': { payload: TrackPayload; result: undefined };
    'track-chapter': { payload: TrackPayload; result: undefined };
}

/** Unsolicited worker → main notification (e.g. cookie write-backs). */
export interface ComputeNotification {
    kind: 'notify';
    name: 'cookie-write';
    value: string;
}
