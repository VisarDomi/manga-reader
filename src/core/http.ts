export function isChapterUnavailable(res: Response): boolean {
    return res.redirected || !res.ok;
}
