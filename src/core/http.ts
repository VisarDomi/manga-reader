export function isChapterUnavailable(res: Response): boolean {
    if (res.redirected || res.status === 404) return true;
    if (!res.ok) throw new Error(`Chapter request failed: ${res.status}`);
    return false;
}
