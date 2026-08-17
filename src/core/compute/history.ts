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
        const sameChapterLocalPartial = remote === undefined
            ? undefined
            : seriesProgress.find(item => (
                item.chapterId === remote.resumeChapterId && !isChapterComplete(item)
            ));

        const chapters: ChapterStateModel[] = card.chapterIds.map(chapterId => {
            const state: ChapterStateModel = { chapterId, read: false, partial: false };
            if (remote !== undefined) {
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
            const saved = byChapter.get(progressKey(card.seriesSlug, chapterId));
            const localCanOverride = remote === undefined
                ? saved !== undefined
                : saved === sameChapterLocalPartial;
            if (localCanOverride && saved !== undefined) {
                state.partial = !isChapterComplete(saved);
                state.read = isChapterComplete(saved);
                state.remoteResumePercent = undefined;
                state.localImageIndex = saved.imageIndex;
            }
            return state;
        });

        let cover: CoverResumeModel;
        if (sameChapterLocalPartial !== undefined) {
            cover = {
                kind: 'local-partial',
                chapterId: sameChapterLocalPartial.chapterId,
                imageIndex: sameChapterLocalPartial.imageIndex,
            };
        } else if (remote !== undefined && remote.resumePercent !== undefined && remote.resumePercent < 100) {
            cover = {
                kind: 'remote-partial',
                chapterId: remote.resumeChapterId,
                percent: remote.resumePercent,
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
            const localPartial = newestPartial(seriesProgress);
            if (localPartial !== undefined) {
                cover = {
                    kind: 'local-partial',
                    chapterId: localPartial.chapterId,
                    imageIndex: localPartial.imageIndex,
                };
            } else {
                const locallyReadChapterIds = seriesProgress
                    .filter(isChapterComplete)
                    .map(item => item.chapterId);
                if (locallyReadChapterIds.length > 0) {
                    cover = { kind: 'read', locallyReadChapterIds };
                } else {
                    cover = { kind: 'none' };
                }
            }
        }

        return { seriesSlug: card.seriesSlug, cover, chapters };
    });
}
