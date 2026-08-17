// Canonical image retry registry.
//
// Render sites register every image they create with registerImage(). The
// registry retries ONLY tracked images that failed to load, with per-image
// exponential backoff. The retry timer exists only while tracked images
// remain and stops entirely when the set is empty, so a healthy page costs
// nothing after the first check.
//
// Keep this module in sync with the identical module in gallery-reader —
// the two repos deliberately share this exact contract so image retry
// behaves the same everywhere.

const FIRST_IMAGE_RETRY_MS = 1_000;
const MAX_IMAGE_RETRY_MS = 2_147_483_647;

interface ImageRetryState {
    source: string;
    delay: number;
    retryAt: number;
}

const trackedImages = new Set<HTMLImageElement>();
const retryStates = new WeakMap<HTMLImageElement, ImageRetryState>();
let retryTimer: number | null = null;

export function registerImage(image: HTMLImageElement): void {
    trackedImages.add(image);
    scheduleRetry();
}

/** Test/diagnostic seam: how many images are currently tracked. */
export function registeredImageCount(): number {
    return trackedImages.size;
}

/** Test seam: clear all tracked images and any pending timer. */
export function resetImageRegistry(): void {
    trackedImages.clear();
    if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
    }
}

function scheduleRetry(): void {
    if (retryTimer !== null || trackedImages.size === 0) return;
    retryTimer = window.setTimeout(runRetry, FIRST_IMAGE_RETRY_MS);
}

function runRetry(): void {
    retryTimer = null;
    if (document.visibilityState === 'hidden') {
        // Frozen (bfcache) or backgrounded: do nothing, keep waiting.
        scheduleRetry();
        return;
    }
    const now = Date.now();
    for (const image of [...trackedImages]) {
        if (!image.isConnected) {
            trackedImages.delete(image);
            continue;
        }
        const source = image.getAttribute('src');
        if (!source?.trim()) {
            trackedImages.delete(image);
            continue;
        }
        if (image.naturalWidth > 0) {
            trackedImages.delete(image);
            continue;
        }

        let state = retryStates.get(image);
        if (!state || state.source !== source) {
            state = { source, delay: FIRST_IMAGE_RETRY_MS, retryAt: now };
            retryStates.set(image, state);
        }
        if (!image.complete || now < state.retryAt) continue;

        // Safari iOS doesn't fire img.onerror on 429s; failed images need polling.
        const url = new URL(source);
        if (url.origin === location.origin) url.searchParams.set('retry', Date.now().toString());
        image.src = ''; // Safari iOS needs the source cleared before reassigning the same URL
        image.src = url.href;

        state.delay = Math.min(state.delay * 2, MAX_IMAGE_RETRY_MS);
        state.retryAt = now + state.delay;
        state.source = image.src;
    }
    scheduleRetry();
}
