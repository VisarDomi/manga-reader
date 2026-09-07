// Wire protocol between the main thread and the compute worker.
// Both sides must stay DOM-free and serializable.

import type {
    ChapterData,
    HomePage,
    RemoteSeriesHistory,
} from '../../provider/types';
import type { CardInput, CardResolution } from './history';
import type { ChapterProgress } from './progress';
import type { DatabaseBackup } from './backup';
import type { BackupCommand } from '../backup-engine';

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
    remoteHistory: RemoteSeriesHistory[];
}

interface FetchHomePayload {
    provider: string;
    cursor: string | null;
}

interface SnapshotPayload {
    cookies: string;
    href: string;
}

interface RemoteHistoryPayload {
    provider: string;
}

interface TrackPayload {
    provider: string;
    data: ChapterData;
}

export interface OpTypes {
    'backup-control': { payload: BackupCommand; result: unknown };
    'backup-export': { payload: undefined; result: DatabaseBackup };
    'backup-import': { payload: unknown; result: undefined };
    'save-progress': { payload: SaveProgressPayload; result: ChapterProgress };
    'history-resolve': { payload: HistoryResolvePayload; result: CardResolution[] };
    'fetch-home': { payload: FetchHomePayload; result: HomePage };
    'cookie-snapshot': { payload: SnapshotPayload; result: undefined };
    'remote-history': { payload: RemoteHistoryPayload; result: RemoteSeriesHistory[] };
    'track-chapter': { payload: TrackPayload; result: undefined };
}

export enum ComputeNotificationKind {
    Notify,
}

export enum ComputeNotificationName {
    CookieWrite,
}

/** Unsolicited worker → main notification (e.g. cookie write-backs). */
export interface ComputeNotification {
    kind: ComputeNotificationKind.Notify;
    name: ComputeNotificationName.CookieWrite;
    value: string;
}
