// Pure, worker-safe resolution of per-card history state. The main thread
// mechanically applies the returned models to DOM elements.

import {
    isChapterComplete,
    progressBySeries,
    type ChapterProgress,
} from './progress';

export interface CardInput {
    seriesSlug: string;
    /** Provider-specific local progress identity. */
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
        /** Most recent local complete — the precise last page. */
        latestLocalComplete: { chapterId: string; imageIndex: number };
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
    progress: ChapterProgress[];
}

export function resolveHistory(input: ResolveHistoryInput): CardResolution[] {
    const localIndex = progressBySeries(input.progress);

    return input.cards.map(card => {
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
        } else {
            cover = { kind: CoverResumeKind.None };
        }

        return { seriesSlug: card.seriesSlug, cover, chapters };
    });
}
