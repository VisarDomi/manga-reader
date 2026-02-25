const available = typeof localStorage !== 'undefined';

export function getJson<T>(key: string, fallback: T): T {
    if (!available) return fallback;
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    try { return JSON.parse(raw) as T; }
    catch { return fallback; }
}

export function setJson(key: string, value: unknown): void {
    if (!available) return;
    localStorage.setItem(key, JSON.stringify(value));
}

export function getString(key: string, fallback: string): string {
    if (!available) return fallback;
    return localStorage.getItem(key) ?? fallback;
}

export function setString(key: string, value: string): void {
    if (!available) return;
    localStorage.setItem(key, value);
}

export function remove(key: string): void {
    if (!available) return;
    localStorage.removeItem(key);
}
