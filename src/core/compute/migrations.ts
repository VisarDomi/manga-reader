import {
    progressId,
    type ChapterProgress,
} from './progress';
import {
    progressSnapshot,
    replaceProgress,
} from './store';

/** Stored progress shapes. Add one value for each durable format change. */
enum ProgressSchemaVersion {
    PerChapter = 1,
    ResumePosition = 2,
    CanonicalProviderIdentity = 3,
}

const CURRENT_PROGRESS_SCHEMA = ProgressSchemaVersion.CanonicalProviderIdentity;
const PROGRESS_SCHEMA_METADATA_KEY = 'progress-schema-version';

/** Identifies unversioned storage created before migration metadata existed. */
function initialProgressSchema(entries: ChapterProgress[]): ProgressSchemaVersion {
    if (entries.length === 0) return CURRENT_PROGRESS_SCHEMA;
    return entries.some(entry => entry.id !== progressId(entry.provider, entry.seriesSlug))
        ? ProgressSchemaVersion.PerChapter
        : ProgressSchemaVersion.ResumePosition;
}

interface ProgressMigrationResult {
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
    if (value === ProgressSchemaVersion.CanonicalProviderIdentity) {
        return ProgressSchemaVersion.CanonicalProviderIdentity;
    }
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

/** One-time v2 -> v3 transform: fold old Asura URL slugs into its history identity. */
function canonicalProviderIdentities(entries: ChapterProgress[]): ChapterProgress[] {
    const byIdentity = new Map<string, ChapterProgress>();
    for (const entry of entries) {
        const seriesSlug = entry.provider === 'asurascans'
            ? entry.seriesSlug.replace(/-[0-9a-f]{8}$/i, '')
            : entry.seriesSlug;
        const id = progressId(entry.provider, seriesSlug);
        const migrated = { ...entry, id, seriesSlug };
        const current = byIdentity.get(id);
        if (current === undefined || migrated.updatedAt >= current.updatedAt) {
            byIdentity.set(id, migrated);
        }
    }
    return [...byIdentity.values()];
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

/** Converts an IndexedDB snapshot to the current in-memory contract. */
function migrateProgress(
    storedEntries: ChapterProgress[],
    storedSchemaVersion: unknown,
): ProgressMigrationResult {
    let entries = storedEntries;
    let version = schemaVersion(storedSchemaVersion);
    let needsCommit = false;

    while (version !== CURRENT_PROGRESS_SCHEMA) {
        switch (version) {
            case ProgressSchemaVersion.PerChapter:
                entries = perChapterToResumePosition(entries);
                version = ProgressSchemaVersion.ResumePosition;
                needsCommit = true;
                break;
            case ProgressSchemaVersion.ResumePosition:
                entries = canonicalProviderIdentities(entries);
                version = ProgressSchemaVersion.CanonicalProviderIdentity;
                needsCommit = true;
                break;
            default:
                throw new Error(`No migration to current progress schema from version ${version}`);
        }
    }
    assertResumePositions(entries);
    return { entries, schemaVersion: version, needsCommit };
}

/** The only progress-loading boundary exposed to the worker. */
export async function loadProgress(): Promise<ChapterProgress[]> {
    const snapshot = await progressSnapshot(PROGRESS_SCHEMA_METADATA_KEY);
    const entries = snapshot.entries.map(chapterProgress);
    let storedSchemaVersion = snapshot.metadata;
    let needsCommit = false;
    if (storedSchemaVersion === undefined) {
        storedSchemaVersion = initialProgressSchema(entries);
        needsCommit = true;
    }
    const result = migrateProgress(entries, storedSchemaVersion);
    if (needsCommit || result.needsCommit) {
        await replaceProgress(
            result.entries,
            PROGRESS_SCHEMA_METADATA_KEY,
            result.schemaVersion,
        );
    }
    return result.entries;
}
