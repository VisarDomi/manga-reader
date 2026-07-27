export function hashImageIndex(hash: string): string | undefined {
    const imageIndex = hash.startsWith('#') ? hash.slice(1) : hash;
    return imageIndex || undefined;
}
