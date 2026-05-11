export function imageProxyUrl(url: string, referer?: string): string {
    let result = `/api/image?url=${encodeURIComponent(url)}`;
    if (referer) result += `&referer=${encodeURIComponent(referer)}`;
    return result;
}
