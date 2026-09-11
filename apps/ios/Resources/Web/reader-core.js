// Generated from src/core/scroll-settle.ts and image-retry.ts.
(()=>{
// Safari can report scrollend before its visible movement has settled. Sample
// position after 100 ms, not at event delivery. This never blocks the UI thread.
function onSettledScroll(callback) {
    let timer;
    let scrolling = false;
    let touching = false;
    let active = true;
    const cancel = () => { clearTimeout(timer); timer = undefined; };
    const schedule = () => {
        cancel();
        if (scrolling || touching || !active || document.hidden)
            return;
        timer = setTimeout(() => {
            timer = undefined;
            if (active && !document.hidden && !scrolling && !touching)
                callback();
        }, 100);
    };
    window.addEventListener('scroll', () => { scrolling = true; cancel(); }, { passive: true });
    window.addEventListener('scrollend', () => { scrolling = false; schedule(); });
    window.addEventListener('touchstart', () => { touching = true; cancel(); }, { passive: true });
    const touchFinished = (event) => {
        touching = event.touches.length > 0;
        if (!touching)
            schedule();
    };
    window.addEventListener('touchend', touchFinished, { passive: true });
    window.addEventListener('touchcancel', touchFinished, { passive: true });
    window.addEventListener('pagehide', () => { active = false; touching = false; cancel(); });
    window.addEventListener('pageshow', () => { active = true; scrolling = false; });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            scrolling = false;
            touching = false;
            cancel();
        }
    });
    // Image loads, initial restoration and bfcache restoration use the same
    // settling gate; none may bypass an in-progress scroll.
    return schedule;
}
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
class ImageRetryRegistry {
    trackedImages = new Set();
    retryStates = new WeakMap();
    retryTimer = null;
    register(image) {
        this.trackedImages.add(image);
        this.scheduleRetry();
    }
    scheduleRetry() {
        if (this.retryTimer !== null || this.trackedImages.size === 0)
            return;
        this.retryTimer = window.setTimeout(() => this.runRetry(), FIRST_IMAGE_RETRY_MS);
    }
    runRetry() {
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
            if (!image.complete || now < state.retryAt)
                continue;
            // Safari iOS doesn't fire img.onerror on 429s; failed images need polling.
            const url = new URL(source);
            if (url.origin === location.origin)
                url.searchParams.set('retry', Date.now().toString());
            image.src = ''; // Safari iOS needs the source cleared before reassigning the same URL
            image.src = url.href;
            state.delay = Math.min(state.delay * 2, MAX_IMAGE_RETRY_MS);
            state.retryAt = now + state.delay;
            state.source = image.src;
        }
        this.scheduleRetry();
    }
}

window.ReaderCore = { onSettledScroll, ImageRetryRegistry };
})();
