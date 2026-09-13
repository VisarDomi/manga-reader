// Shared source formatting for userscript and native Home.

export function formatUploadedAt(value: string | null): string {
    if (value === null || value.trim() === '') return '';
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return value;
    const elapsed = Math.max(0, Date.now() - timestamp);
    const minutes = Math.floor(elapsed / 60_000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? 'last week' : `${weeks} weeks ago`;
}

export function unlockCountdown(unlockAt: string): string {
    const remaining = new Date(unlockAt).getTime() - Date.now();
    if (remaining <= 0) return '0m';
    const hours = Math.floor(remaining / 3_600_000);
    const minutes = Math.floor((remaining % 3_600_000) / 60_000);
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function statusText(loaded: number, total: number | undefined, loading: boolean): string {
    const count = total === undefined ? `${loaded}` : `${loaded} of ${total}`;
    return loading ? `Loaded ${count} series · loading more…` : `Loaded ${count} series`;
}
