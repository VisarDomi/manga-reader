interface TsReaderSource {
    source?: unknown;
    images?: unknown;
}

interface TsReaderData {
    defaultSource?: unknown;
    sources?: unknown;
}

export function defaultReaderImages(value: unknown): string[] {
    if (typeof value !== 'object' || value === null) {
        throw new Error('Reader data is not an object');
    }
    const data = value as TsReaderData;
    if (typeof data.defaultSource !== 'string' || data.defaultSource.trim() === '') {
        throw new Error('Reader data has no default source');
    }
    if (!Array.isArray(data.sources)) throw new Error('Reader sources are not an array');

    const matches = (data.sources as TsReaderSource[])
        .filter(source => source.source === data.defaultSource);
    if (matches.length !== 1) {
        throw new Error(`Reader default source ${data.defaultSource} matched ${matches.length} sources`);
    }

    const images = matches[0].images;
    if (!Array.isArray(images)
        || images.length === 0
        || !images.every(image => typeof image === 'string' && image.trim() !== '')) {
        throw new Error('Reader default source has invalid images');
    }
    return images;
}
