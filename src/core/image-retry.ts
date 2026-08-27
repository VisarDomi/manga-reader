// Canonical image retry registry.
//
// Each route owns a registry and registers every image it creates. The
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

export class ImageRetryRegistry {
    private readonly trackedImages = new Set<HTMLImageElement>();
    private readonly retryStates = new WeakMap<HTMLImageElement, ImageRetryState>();
    private retryTimer: number | null = null;

    register(image: HTMLImageElement): void {
        this.trackedImages.add(image);
        this.scheduleRetry();
    }

    private scheduleRetry(): void {
        if (this.retryTimer !== null || this.trackedImages.size === 0) return;
        this.retryTimer = window.setTimeout(() => this.runRetry(), FIRST_IMAGE_RETRY_MS);
    }

    private runRetry(): void {
        this.retryTimer = null;
        if (document.hidden) {
            // Frozen (bfcache) or backgrounded: do nothing, keep waiting.
            this.scheduleRetry();
            return;
        }
        const now = Date.now();
        for (const image of [...this.trackedImages]) {
            if (!image.isConnected) {
                this.trackedImages.delete(image);
                continue;
            }
            const source = image.getAttribute('src');
            if (!source?.trim()) {
                this.trackedImages.delete(image);
                continue;
            }
            if (image.naturalWidth > 0) {
                this.trackedImages.delete(image);
                continue;
            }

            let state = this.retryStates.get(image);
            if (!state || state.source !== source) {
                state = { source, delay: FIRST_IMAGE_RETRY_MS, retryAt: now };
                this.retryStates.set(image, state);
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
        this.scheduleRetry();
    }
}
