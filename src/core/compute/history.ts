// Pure, worker-safe resolution of per-card history state. This is the decision
// half of the old synchronous applyHistory pass in src/routes/home.ts: it computes
// WHAT the UI should show; the main thread mechanically applies the returned
// models to DOM elements.

import type { RemoteSeriesHistory } from '../../provider/types';
import {
    buildProgressIndex,
    isChapterComplete,
    newestPartial,
    progressKey,
    type ChapterProgress,
} from './progress';

export interface CardInput {
    seriesSlug: string;
    /** Matches RemoteSeriesHistory.seriesId; provider-specific identity. */
    historyId: string;
    chapterIds: string[];
}

export type CoverResumeModel =
    | { kind: 'none' }
    | { kind: 'local-partial'; chapterId: string; imageIndex: number }
    | { kind: 'remote-partial'; chapterId: string; percent: number }
    | {
        kind: 'read';
        readThroughChapterId?: string;
        /** Present when remote history drives the resume; links straight to it. */
        resumeChapterId?: string;
        locallyReadChapterIds: string[];
        /** Most recent local complete — the precise last page. */
        latestLocalComplete?: { chapterId: string; imageIndex: number };
      };

export interface ChapterStateModel {
    chapterId: string;
    read: boolean;
    partial: boolean;
    /** Remote resume percentage when the provider drives this chapter's state. */
    remoteResumePercent?: number;
    /** Local saved page when local progress overrides; main skips it on locked chapters. */
    localImageIndex?: number;
}

export interface CardResolution {
    seriesSlug: string;
    cover: CoverResumeModel;
    chapters: ChapterStateModel[];
}

export interface ResolveHistoryInput {
    cards: CardInput[];
    remoteHistory: RemoteSeriesHistory[];
    progress: ChapterProgress[];
}

function chapterAtOrBefore(chapterId: string, boundaryId: string): boolean {
    const chapter = Number(chapterId);
    const boundary = Number(boundaryId);
    if (Number.isFinite(chapter) && Number.isFinite(boundary)) return chapter <= boundary;
    return chapterId === boundaryId;
}

export function resolveHistory(input: ResolveHistoryInput): CardResolution[] {
    const remoteIndex = new Map(input.remoteHistory.map(item => [item.seriesId, item]));
    const { byChapter, bySeries } = buildProgressIndex(input.progress);

    return input.cards.map(card => {
        const remote = remoteIndex.get(card.historyId);
        const seriesProgress = bySeries.get(card.seriesSlug) ?? [];

        const chapters: ChapterStateModel[] = card.chapterIds.map(chapterId => {
            const state: ChapterStateModel = { chapterId, read: false, partial: false };
            const saved = byChapter.get(progressKey(card.seriesSlug, chapterId));
            if (saved !== undefined) {
                // Local trumps server: the reader keeps the server fresh, so
                // any local entry is the most recent truth for this chapter.
                state.partial = !isChapterComplete(saved);
                state.read = isChapterComplete(saved);
                state.localImageIndex = saved.imageIndex;
            } else if (remote !== undefined) {
                if (
                    remote.readThroughChapterId !== undefined
                    && chapterAtOrBefore(chapterId, remote.readThroughChapterId)
                ) {
                    state.read = true;
                }
                if (chapterId === remote.resumeChapterId && remote.resumePercent !== undefined) {
                    state.partial = remote.resumePercent < 100;
                    state.read = remote.resumePercent >= 100;
                    state.remoteResumePercent = remote.resumePercent;
                }
            }
            return state;
        });

        const completes = seriesProgress.filter(isChapterComplete);
        const locallyReadChapterIds = completes.map(item => item.chapterId);
        const latestLocalComplete = completes.length > 0
            ? completes.sort((left, right) => (
                right.updatedAt - left.updatedAt
                || Number(right.chapterId) - Number(left.chapterId)
            ))[0]
            : undefined;

        let cover: CoverResumeModel;
        const localPartial = newestPartial(seriesProgress);
        if (localPartial !== undefined) {
            cover = {
                kind: 'local-partial',
                chapterId: localPartial.chapterId,
                imageIndex: localPartial.imageIndex,
            };
        } else if (remote !== undefined && remote.resumePercent !== undefined && remote.resumePercent < 100) {
            cover = {
                kind: 'remote-partial',
                chapterId: remote.resumeChapterId,
                percent: remote.resumePercent,
            };
        } else if (latestLocalComplete !== undefined) {
            cover = {
                kind: 'read',
                locallyReadChapterIds,
                latestLocalComplete: {
                    chapterId: latestLocalComplete.chapterId,
                    imageIndex: latestLocalComplete.imageIndex,
                },
            };
        } else if (remote !== undefined) {
            cover = {
                kind: 'read',
                readThroughChapterId: remote.readThroughChapterId === undefined
                    ? remote.resumeChapterId
                    : remote.readThroughChapterId,
                resumeChapterId: remote.resumeChapterId,
                locallyReadChapterIds: [],
            };
        } else {
            cover = { kind: 'none' };
        }

        return { seriesSlug: card.seriesSlug, cover, chapters };
    });
}
