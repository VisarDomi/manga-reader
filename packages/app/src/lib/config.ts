export function imageProxyUrl(url: string, referer?: string): string {
    let result = `/api/image?url=${encodeURIComponent(url)}`;
    if (referer) result += `&referer=${encodeURIComponent(referer)}`;
    return result;
}

export function byteCacheUrl(url: string, referer?: string): string {
    let result = `/api/byte?url=${encodeURIComponent(url)}`;
    if (referer) result += `&referer=${encodeURIComponent(referer)}`;
    return result;
}
