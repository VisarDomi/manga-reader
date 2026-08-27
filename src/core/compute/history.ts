// Pure, worker-safe resolution of per-card history state. The main thread
// mechanically applies the returned models to DOM elements.

import type { RemoteSeriesHistory } from '../../provider/types';
import {
    isChapterComplete,
    progressBySeries,
    type ChapterProgress,
} from './progress';

export interface CardInput {
    seriesSlug: string;
    /** Matches RemoteSeriesHistory.seriesId; provider-specific identity. */
    historyId: string;
    chapterIds: string[];
}

export enum CoverResumeKind {
    None,
    LocalPartial,
    Read,
}

export type CoverResumeModel =
    | { kind: CoverResumeKind.None }
    | { kind: CoverResumeKind.LocalPartial; chapterId: string; imageIndex: number }
    | {
        kind: CoverResumeKind.Read;
        /** Present when remote history drives the resume; links straight to it. */
        resumeChapterId?: string;
        /** Most recent local complete — the precise last page. */
        latestLocalComplete?: { chapterId: string; imageIndex: number };
      };

interface ChapterStateModel {
    chapterId: string;
    read: boolean;
    partial: boolean;
    /** Local saved page when local progress overrides; main skips it on locked chapters. */
    localImageIndex?: number;
}

export interface CardResolution {
    seriesSlug: string;
    cover: CoverResumeModel;
    chapters: ChapterStateModel[];
}

interface ResolveHistoryInput {
    cards: CardInput[];
    remoteHistory: RemoteSeriesHistory[];
    progress: ChapterProgress[];
}

export function resolveHistory(input: ResolveHistoryInput): CardResolution[] {
    const remoteIndex = new Map(input.remoteHistory.map(item => [item.seriesId, item]));
    const localIndex = progressBySeries(input.progress);

    return input.cards.map(card => {
        const remote = remoteIndex.get(card.historyId);
        const remotelyRead = new Set(remote?.readChapterIds ?? []);
        const local = localIndex.get(card.historyId);
        const localChapterIndex = local === undefined
            ? -1
            : card.chapterIds.indexOf(local.chapterId);

        const chapters: ChapterStateModel[] = card.chapterIds.map((chapterId, chapterIndex) => {
            const state: ChapterStateModel = { chapterId, read: false, partial: false };
            if (local !== undefined && localChapterIndex !== -1) {
                if (chapterIndex > localChapterIndex) state.read = true;
                if (chapterIndex === localChapterIndex) {
                    state.partial = !isChapterComplete(local);
                    state.read = isChapterComplete(local);
                    state.localImageIndex = local.imageIndex;
                }
            } else if (local === undefined && remotelyRead.has(chapterId)) {
                state.read = true;
            }
            return state;
        });

        let cover: CoverResumeModel;
        if (local !== undefined && !isChapterComplete(local)) {
            cover = {
                kind: CoverResumeKind.LocalPartial,
                chapterId: local.chapterId,
                imageIndex: local.imageIndex,
            };
        } else if (local !== undefined) {
            cover = {
                kind: CoverResumeKind.Read,
                latestLocalComplete: {
                    chapterId: local.chapterId,
                    imageIndex: local.imageIndex,
                },
            };
        } else if (remote !== undefined) {
            cover = {
                kind: CoverResumeKind.Read,
                resumeChapterId: remote.resumeChapterId,
            };
        } else {
            cover = { kind: CoverResumeKind.None };
        }

        return { seriesSlug: card.seriesSlug, cover, chapters };
    });
}
