import {
    progressId,
    type ChapterProgress,
} from './progress';

/** Stored progress shapes. Add one value for each durable format change. */
export enum ProgressSchemaVersion {
    PerChapter = 1,
    ResumePosition = 2,
}

export const CURRENT_PROGRESS_SCHEMA = ProgressSchemaVersion.ResumePosition;
export const PROGRESS_SCHEMA_METADATA_KEY = 'progress-schema-version';

/** Seeds the progress version when IndexedDB first gains migration metadata. */
export function initialProgressSchema(databaseOldVersion: number): ProgressSchemaVersion {
    if (databaseOldVersion === 0) return CURRENT_PROGRESS_SCHEMA;
    if (databaseOldVersion === 1) return ProgressSchemaVersion.PerChapter;
    throw new Error(`Cannot identify progress schema from database version ${databaseOldVersion}`);
}

export interface ProgressMigrationResult {
    entries: ChapterProgress[];
    schemaVersion: ProgressSchemaVersion;
    needsCommit: boolean;
}

function chapterProgress(value: unknown): ChapterProgress {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Stored progress entry is not an object');
    }
    const entry = value as Partial<ChapterProgress>;
    if (
        typeof entry.id !== 'string'
        || typeof entry.provider !== 'string'
        || typeof entry.seriesSlug !== 'string'
        || typeof entry.chapterId !== 'string'
        || !Number.isInteger(entry.imageIndex)
        || !Number.isInteger(entry.totalImages)
        || typeof entry.updatedAt !== 'number'
        || !Number.isFinite(entry.updatedAt)
        || entry.imageIndex! < 0
        || entry.totalImages! <= entry.imageIndex!
    ) {
        throw new Error('Stored progress entry is invalid');
    }
    return entry as ChapterProgress;
}

function schemaVersion(value: unknown): ProgressSchemaVersion {
    if (value === ProgressSchemaVersion.PerChapter) return ProgressSchemaVersion.PerChapter;
    if (value === ProgressSchemaVersion.ResumePosition) return ProgressSchemaVersion.ResumePosition;
    throw new Error(`Unsupported progress schema version: ${String(value)}`);
}

/** One-time v1 -> v2 transform: retain the last visited page per series. */
function perChapterToResumePosition(entries: ChapterProgress[]): ChapterProgress[] {
    const bySeries = new Map<string, ChapterProgress>();
    for (const entry of entries) {
        const id = progressId(entry.provider, entry.seriesSlug);
        const migrated = { ...entry, id };
        const current = bySeries.get(id);
        if (current === undefined || migrated.updatedAt >= current.updatedAt) {
            bySeries.set(id, migrated);
        }
    }
    return [...bySeries.values()];
}

function assertResumePositions(entries: ChapterProgress[]): void {
    const identities = new Set<string>();
    for (const entry of entries) {
        const expectedId = progressId(entry.provider, entry.seriesSlug);
        if (entry.id !== expectedId) throw new Error('Stored progress does not match the current schema');
        if (identities.has(expectedId)) throw new Error('Stored progress contains duplicate resume positions');
        identities.add(expectedId);
    }
}

/**
 * Converts an IndexedDB snapshot to the current in-memory contract. The
 * caller commits the returned snapshot and schema version in one transaction.
 */
export function migrateProgress(
    storedEntries: unknown[],
    storedSchemaVersion: unknown,
): ProgressMigrationResult {
    let entries = storedEntries.map(chapterProgress);
    let version = schemaVersion(storedSchemaVersion);
    let needsCommit = false;

    switch (version) {
        case ProgressSchemaVersion.PerChapter:
            entries = perChapterToResumePosition(entries);
            version = ProgressSchemaVersion.ResumePosition;
            needsCommit = true;
            break;
        case ProgressSchemaVersion.ResumePosition:
            break;
    }

    if (version !== CURRENT_PROGRESS_SCHEMA) {
        throw new Error(`No migration to current progress schema from version ${version}`);
    }
    assertResumePositions(entries);
    return { entries, schemaVersion: version, needsCommit };
}
